import { resolve } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { createAgent, ALL_AGENTS, AGENT_LABELS, type AgentType, type AgentLabel, type Agent } from "./agent.ts";
import {
  buildAnalystChatPrompt,
  buildRound1Prompt,
  buildRound2Prompt,
  buildRound3Prompt,
  buildRoundSummaryPrompt,
  buildFinalReportPrompt,
  DETECT_LANGUAGE_PROMPT,
  type RoundHistory,
} from "./prompts.ts";
import { createSSERegistry, sseResponse as createSSEResponse } from "./lib/sse.ts";
import { esc } from "./lib/html.ts";
import { initHighlighter, highlightCode } from "./lib/shiki.ts";
import {
  chatMsgHtml,
  streamHtml,
  logEntryHtml,
  continueButtonHtml,
  artifactsSidebarHtml,
} from "./pages/session.tsx";

// Initialize syntax highlighter at startup
await initHighlighter();

// ── Helpers ──

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

async function writeFileSafe(path: string, content: string) {
  await ensureDir(resolve(path, ".."));
  await Bun.write(path, content);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function assignAgents(agentTypes: AgentType[]): Map<AgentLabel, AgentType> {
  const shuffled = shuffle(agentTypes);
  const map = new Map<AgentLabel, AgentType>();
  const labels = AGENT_LABELS.slice(0, shuffled.length);
  labels.forEach((label, i) => map.set(label, shuffled[i]!));
  return map;
}

function elapsed(startMs: number): string {
  const sec = Math.round((Date.now() - startMs) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function parseAnalystOutput(output: string): { name: string; problem: string } {
  const nameMatch = output.match(/---NAME---\s*\n([^\n]+)/);
  const problemMatch = output.match(/---PROBLEM---\s*\n([\s\S]+)$/);
  const name = nameMatch?.[1]?.trim() || "unknown-problem";
  const problem = problemMatch?.[1]?.trim() || output;
  return { name, problem };
}

// ── Types ──

export interface SessionConfig {
  analyst: AgentType;
  supervisor: AgentType;
  reporter: AgentType;
  participants: AgentType[];
}

interface AgentTiming {
  name: string;
  label: string;
  elapsed: string;
  size: number;
  status: "ok" | "cached" | "failed";
}

interface RoundTiming {
  round: number;
  title: string;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  agents: AgentTiming[];
}

interface SessionMeta {
  startedAt: string;
  completedAt?: string;
  totalElapsedMs?: number;
  lang?: string;
  config?: SessionConfig;
  rounds: RoundTiming[];
}

export interface ActiveSession {
  config: SessionConfig;
  analystAgent: Agent | null;
  chatHistory: Array<{ role: "user" | "assistant"; text: string }>;
  sessionDir: string | null;
  lang: string | null;
  meta: SessionMeta | null;
  phase: "chat" | "running" | "paused" | "done";
  currentRound: number;
  logEntries: string[];
  continueResolve: (() => void) | null;
  workingAgents: Set<string>;   // "1-a", "2-b", "report"
  summarizing: number | null;
}

export interface Artifact {
  path: string;
  type: string;
  round?: number;
  label?: string;
}

export interface SessionInfo {
  name: string;
  hasReport: boolean;
  problem: string;
  rounds: number;
  agents: string[];
  totalElapsedMs?: number;
}

// ── Active sessions state ──

export const activeSessions = new Map<string, ActiveSession>();
const sessionSSE = createSSERegistry<string>();

// ── SSE broadcasting ──

function broadcast(name: string, event: string, data: string) {
  sessionSSE.broadcast(name, event, data);
}

function broadcastLog(name: string, entry: string) {
  const session = activeSessions.get(name);
  if (session) session.logEntries.push(entry);
  broadcast(name, "log", entry);
}

function broadcastArtifacts(name: string) {
  const session = activeSessions.get(name);
  listSessionArtifacts(name).then(artifacts => {
    getSessionAssignment(name).then(assignment => {
      const live = session ? {
        workingAgents: session.workingAgents,
        summarizing: session.summarizing,
        currentRound: session.currentRound,
      } : undefined;
      broadcast(name, "artifacts", artifactsSidebarHtml(name, artifacts, assignment, live));
    });
  });
}

export function sseResponse(name: string): Response {
  const session = activeSessions.get(name);

  let controllerRef: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      sessionSSE.add(name, controller);

      // Catchup: send current state
      if (session) {
        // Send current artifacts with live progress
        listSessionArtifacts(name).then(artifacts => {
          getSessionAssignment(name).then(assignment => {
            const live = {
              workingAgents: session.workingAgents,
              summarizing: session.summarizing,
              currentRound: session.currentRound,
            };
            const html = artifactsSidebarHtml(name, artifacts, assignment, live);
            const payload = `event: artifacts\ndata: ${html.split("\n").map(l => l).join("\ndata: ")}\n\n`;
            try { controller.enqueue(new TextEncoder().encode(payload)); } catch {}
          });
        });
        // If paused, resend continue button
        if (session.phase === "paused" && session.currentRound > 0) {
          const html = continueButtonHtml(name, session.currentRound);
          const payload = `event: continue\ndata: ${html.split("\n").map(l => l).join("\ndata: ")}\n\n`;
          try { controller.enqueue(new TextEncoder().encode(payload)); } catch {}
        }
      }
    },
    cancel() {
      sessionSSE.remove(name, controllerRef);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── Session lifecycle ──

export function createSession(config: SessionConfig): string {
  const ts = Date.now().toString(36);
  const name = `pending-${ts}`;
  activeSessions.set(name, {
    config,
    analystAgent: null,
    chatHistory: [],
    sessionDir: null,
    lang: null,
    meta: null,
    phase: "chat",
    currentRound: 0,
    logEntries: [],
    continueResolve: null,
    workingAgents: new Set(),
    summarizing: null,
  });
  return name;
}

// ── Language detection ──

async function detectLanguage(text: string, model: AgentType): Promise<string> {
  const agent = createAgent(model, process.cwd());
  try {
    const raw = await agent.prompt(DETECT_LANGUAGE_PROMPT + text.slice(0, 500));
    return raw.trim().split("\n")[0]!.trim();
  } finally {
    await agent.close();
  }
}

// ── Analyst chat ──

export async function handleChat(name: string, text: string) {
  const session = activeSessions.get(name);
  if (!session || session.phase !== "chat") return;

  session.chatHistory.push({ role: "user", text });
  broadcast(name, "chat-msg", chatMsgHtml("user", text));

  // Detect language on first message
  if (!session.lang && session.chatHistory.length === 1) {
    try {
      session.lang = await detectLanguage(text, session.config.analyst);
    } catch {}
  }

  // Create analyst agent if needed
  if (!session.analystAgent) {
    let streamText = "";
    session.analystAgent = createAgent(session.config.analyst, process.cwd(), (chunk) => {
      streamText += chunk;
      broadcast(name, "chat-stream", streamHtml(streamText));
    });
  }

  const prompt = buildAnalystChatPrompt(session.chatHistory, session.lang || undefined);
  const response = await session.analystAgent.prompt(prompt);
  session.chatHistory.push({ role: "assistant", text: response });
  broadcast(name, "chat-stream", "");
  broadcast(name, "chat-msg", chatMsgHtml("assistant", response));
}

// ── Run consensus ──

export async function handleRun(name: string) {
  const session = activeSessions.get(name);
  if (!session || session.phase !== "chat") return;

  const finalPrompt = buildAnalystChatPrompt(session.chatHistory, session.lang || undefined) +
    "\n\nThe user is ready. Output the final structured problem now using the ---NAME--- and ---PROBLEM--- format.";

  const output = await session.analystAgent!.prompt(finalPrompt);
  await session.analystAgent!.close();
  session.analystAgent = null;

  const { name: probName, problem } = parseAnalystOutput(output);
  const date = new Date().toISOString().slice(0, 10);
  const sessionName = `${date}-${probName}`;
  session.sessionDir = resolve(process.cwd(), "sessions", sessionName);

  if (!session.lang) {
    try { session.lang = await detectLanguage(problem, session.config.analyst); } catch {}
  }

  await ensureDir(session.sessionDir);
  await writeFileSafe(resolve(session.sessionDir, "problem.md"), problem);

  // Rename session in activeSessions
  activeSessions.delete(name);
  activeSessions.set(sessionName, session);

  session.phase = "running";

  // Tell client to redirect to the new session URL via SSE
  broadcast(name, "redirect", `/sessions/${encodeURIComponent(sessionName)}`);

  // Run consensus async
  runConsensus(sessionName, session, problem).catch(err => {
    broadcastLog(sessionName, logEntryHtml("error", `Error: ${esc(err.message || String(err))}`));
  });
}

// ── Continue ──

export function handleContinue(name: string) {
  const session = activeSessions.get(name);
  if (session?.continueResolve) {
    session.continueResolve();
    session.continueResolve = null;
    session.phase = "running";
  }
}

// ── Consensus pipeline ──

async function saveMeta(session: ActiveSession) {
  if (session.meta && session.sessionDir) {
    await writeFileSafe(resolve(session.sessionDir, "meta.json"), JSON.stringify(session.meta, null, 2));
  }
}

async function readExisting(baseDir: string, round: number, label: string): Promise<string | null> {
  try { return await Bun.file(resolve(baseDir, `r${round}`, label, "solution.md")).text(); }
  catch { return null; }
}

async function runAgentsSettled(
  name: string,
  round: number,
  agents: Map<AgentLabel, Agent>,
  labels: string[],
  baseDir: string,
  solutions: Map<string, string>,
  buildPrompt: (label: string, agent: Agent) => string,
  roundMeta: RoundTiming,
): Promise<string[]> {
  const failed: string[] = [];

  const session = activeSessions.get(name);

  // Show all spinners at once
  for (const label of labels) {
    session?.workingAgents.add(`${round}-${label}`);
  }
  broadcastArtifacts(name);

  const results = await Promise.allSettled(
    labels.map(async (label) => {
      const existing = await readExisting(baseDir, round, label);
      if (existing) {
        solutions.set(label, existing);
        const size = Math.round(existing.length / 1024);
        roundMeta.agents.push({ name: agents.get(label as AgentLabel)!.name, label, elapsed: "cached", size, status: "cached" });
        session?.workingAgents.delete(`${round}-${label}`);
        broadcastArtifacts(name);
        return;
      }

      const agent = agents.get(label as AgentLabel)!;
      const dir = resolve(baseDir, `r${round}`, label);
      await ensureDir(dir);

      const start = Date.now();
      const prompt = buildPrompt(label, agent);
      await writeFileSafe(resolve(dir, "prompt.md"), prompt);
      const output = await agent.prompt(prompt);
      await writeFileSafe(resolve(dir, "solution.md"), output);
      solutions.set(label, output);
      const elapsedStr = elapsed(start);
      const size = Math.round(output.length / 1024);
      roundMeta.agents.push({ name: agent.name, label, elapsed: elapsedStr, size, status: "ok" });
      session?.workingAgents.delete(`${round}-${label}`);
      broadcastArtifacts(name);
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      const label = labels[i]!;
      const agent = agents.get(label as AgentLabel)!;
      failed.push(label);
      roundMeta.agents.push({ name: agent.name, label, elapsed: "0s", size: 0, status: "failed" });
      session?.workingAgents.delete(`${round}-${label}`);
      broadcastArtifacts(name);
    }
  }
  return failed;
}

async function roundSummary(name: string, solutions: Map<string, string>, round: number, model: AgentType, baseDir: string, lang?: string) {
  const session = activeSessions.get(name);
  if (session) session.summarizing = round;
  broadcastArtifacts(name);

  const summarizer = createAgent(model, process.cwd());
  try {
    const summary = await summarizer.prompt(buildRoundSummaryPrompt(solutions, lang));
    await writeFileSafe(resolve(baseDir, `r${round}`, "summary.md"), summary);
  } finally {
    await summarizer.close();
    if (session) session.summarizing = null;
    broadcastArtifacts(name);
  }
}

function waitForContinue(name: string, session: ActiveSession, round: number): Promise<void> {
  session.phase = "paused";
  session.currentRound = round;
  broadcast(name, "continue", continueButtonHtml(name, round));
  return new Promise((resolve) => { session.continueResolve = resolve; });
}

async function runConsensus(name: string, session: ActiveSession, problem: string) {
  const config = session.config;
  const baseDir = session.sessionDir!;
  const lang = session.lang || undefined;
  const sessionStart = Date.now();

  session.meta = { startedAt: new Date().toISOString(), lang, config, rounds: [] };
  await saveMeta(session);

  const assignment = assignAgents(config.participants);
  const agents = new Map<AgentLabel, Agent>();

  await writeFileSafe(resolve(baseDir, "assignment.json"), JSON.stringify(Object.fromEntries(assignment)));

  for (const [label, agentType] of assignment) {
    agents.set(label, createAgent(agentType, baseDir));
  }

  const labels = [...agents.keys()];
  const allFailed: string[] = [];
  const allRounds: RoundHistory[] = [];

  async function executeRound(
    round: number,
    title: string,
    buildPrompt: (label: string, agent: Agent) => string,
  ): Promise<{ solutions: Map<string, string>; failed: string[] }> {
    const roundStart = Date.now();
    const roundMeta: RoundTiming = { round, title, startedAt: new Date().toISOString(), agents: [] };
    session.meta!.rounds.push(roundMeta);

    session.currentRound = round;
    const solutions = new Map<string, string>();
    const failed = await runAgentsSettled(name, round, agents, labels, baseDir, solutions, buildPrompt, roundMeta);

    if (solutions.size > 0) await roundSummary(name, solutions, round, config.supervisor, baseDir, lang);

    roundMeta.completedAt = new Date().toISOString();
    roundMeta.elapsedMs = Date.now() - roundStart;
    await saveMeta(session);

    if (round < 3) {
      await waitForContinue(name, session, round);
    }
    return { solutions, failed };
  }

  try {
    // Round 1: Solve
    let { solutions, failed } = await executeRound(1, "Solve", () => buildRound1Prompt(problem, lang));
    allFailed.push(...failed.map(l => `r1:${l}`));
    allRounds.push({ round: 1, title: "Solve", solutions: new Map(solutions) });

    // Round 2: Improve
    const r1Solutions = solutions;
    ({ solutions, failed } = await executeRound(2, "Improve", (label) => {
      const otherLabels = shuffle(labels.filter(l => l !== label));
      const peerSolutions = otherLabels.map(l => r1Solutions.get(l)!).filter(Boolean);
      return buildRound2Prompt(problem, peerSolutions, lang);
    }));
    allFailed.push(...failed.map(l => `r2:${l}`));
    allRounds.push({ round: 2, title: "Improve", solutions: new Map(solutions) });

    // Round 3: Defend
    const r2Solutions = solutions;
    ({ solutions, failed } = await executeRound(3, "Defend", (label) => {
      const ownSolution = r2Solutions.get(label) || "";
      const otherLabels = shuffle(labels.filter(l => l !== label));
      const peerSolutions = otherLabels.map(l => r2Solutions.get(l)!).filter(Boolean);
      return buildRound3Prompt(problem, ownSolution, peerSolutions, lang);
    }));
    allFailed.push(...failed.map(l => `r3:${l}`));
    allRounds.push({ round: 3, title: "Defend", solutions: new Map(solutions) });

    // Final Report
    if (await Bun.file(resolve(baseDir, "final-report.md")).exists()) {
      // cached
    } else if (solutions.size > 0) {
      const reportDir = resolve(baseDir, "final");
      await ensureDir(reportDir);
      await writeFileSafe(resolve(reportDir, "problem.md"), problem);
      for (const [label, text] of solutions) {
        await writeFileSafe(resolve(reportDir, `solution-${label}.md`), text);
      }

      session.workingAgents.add("report");
      broadcastArtifacts(name);

      const reporter = createAgent(config.reporter, process.cwd());
      try {
        const report = await reporter.prompt(buildFinalReportPrompt(problem, allRounds, lang));
        await writeFileSafe(resolve(baseDir, "final-report.md"), report);
        await writeFileSafe(resolve(reportDir, "final-report.md"), report);
      } finally {
        await reporter.close();
        session.workingAgents.delete("report");
        broadcastArtifacts(name);
      }
    }

    session.meta!.completedAt = new Date().toISOString();
    session.meta!.totalElapsedMs = Date.now() - sessionStart;
    await saveMeta(session);

    session.phase = "done";
    // Tell clients session is done
    broadcast(name, "done", "true");
  } catch (err: any) {
    broadcastLog(name, logEntryHtml("error", `Error: ${esc(err.message || String(err))}`));
  } finally {
    await Promise.all([...agents.values()].map(a => a.close()));
    // Clean up active session after a delay (let SSE clients catch up)
    setTimeout(() => {
      if (activeSessions.get(name)?.phase === "done") {
        activeSessions.delete(name);
      }
    }, 5000);
  }
}

// ── Sessions & Artifacts API ──

export async function listSessions(): Promise<SessionInfo[]> {
  const dir = resolve(process.cwd(), "sessions");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const sessions: SessionInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sname = entry.name;
      const sdir = resolve(dir, sname);
      const hasReport = await Bun.file(resolve(sdir, "final-report.md")).exists();

      let problem = "";
      try {
        const raw = await Bun.file(resolve(sdir, "problem.md")).text();
        problem = raw.replace(/^##?\s+\w+\s*\n/gm, "").trim().slice(0, 200);
      } catch {}

      let rounds = 0;
      for (let i = 1; i <= 10; i++) {
        const rdir = resolve(sdir, `r${i}`);
        if (await Bun.file(resolve(rdir, "a", "solution.md")).exists() ||
            await Bun.file(resolve(rdir, "b", "solution.md")).exists()) {
          rounds = i;
        } else break;
      }

      const agents: string[] = [];
      try {
        const r1entries = await readdir(resolve(sdir, "r1"), { withFileTypes: true });
        for (const a of r1entries) {
          if (a.isDirectory()) agents.push(a.name);
        }
      } catch {}

      let totalElapsedMs: number | undefined;
      try {
        const meta = JSON.parse(await Bun.file(resolve(sdir, "meta.json")).text());
        totalElapsedMs = meta.totalElapsedMs;
      } catch {}

      sessions.push({ name: sname, hasReport, problem, rounds, agents, totalElapsedMs });
    }
    sessions.sort((a, b) => b.name.localeCompare(a.name));
    return sessions;
  } catch {
    return [];
  }
}

export async function listSessionArtifacts(name: string): Promise<Artifact[]> {
  const sdir = resolve(process.cwd(), "sessions", name);
  const artifacts: Artifact[] = [];

  if (await Bun.file(resolve(sdir, "problem.md")).exists()) {
    artifacts.push({ path: "problem.md", type: "problem" });
  }

  for (let r = 1; r <= 3; r++) {
    for (const label of ["a", "b", "c", "d", "e"]) {
      if (await Bun.file(resolve(sdir, `r${r}`, label, "prompt.md")).exists()) {
        artifacts.push({ path: `r${r}/${label}/prompt.md`, type: "prompt", round: r, label });
      }
      if (await Bun.file(resolve(sdir, `r${r}`, label, "solution.md")).exists()) {
        artifacts.push({ path: `r${r}/${label}/solution.md`, type: "solution", round: r, label });
      }
    }
    if (await Bun.file(resolve(sdir, `r${r}`, "summary.md")).exists()) {
      artifacts.push({ path: `r${r}/summary.md`, type: "summary", round: r });
    }
  }

  if (await Bun.file(resolve(sdir, "final-report.md")).exists()) {
    artifacts.push({ path: "final-report.md", type: "report" });
  }

  return artifacts;
}

export async function getSessionAssignment(name: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Bun.file(resolve(process.cwd(), "sessions", name, "assignment.json")).text());
  } catch {
    return {};
  }
}

// ── Markdown rendering ──

export function renderMarkdown(text: string): string {
  if (!text) return "";

  // Extract code blocks first, replace with placeholders
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(highlightCode(code.trimEnd(), lang || undefined));
    return `\x00CODE${idx}\x00`;
  });

  // Escape HTML in remaining text
  result = result
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Inline code
  result = result.replace(/`([^`]+)`/g, '<code class="bg-gray-800 px-1 rounded text-xs">$1</code>');

  // Headings
  result = result
    .replace(/^#### (.+)$/gm, '<h4 class="text-gray-200 text-xs font-semibold mt-3 mb-1">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="text-gray-200 text-sm font-semibold mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-blue-400 text-sm font-semibold mt-4 mb-1">$1</h2>');

  // Emphasis
  result = result
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Tables
  result = result.replace(/^\|(.+)\|$/gm, (_m, inner) => {
    const cells = inner.split("|").map((c: string) => c.trim());
    if (cells.every((c: string) => /^[-:]+$/.test(c))) return "";
    return "<tr>" + cells.map((c: string) => `<td class="border border-gray-700 px-2 py-1 text-xs">${c}</td>`).join("") + "</tr>";
  });

  // Lists
  result = result
    .replace(/^- (.+)$/gm, '<li class="ml-4 text-xs">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 text-xs">$1</li>');

  // Blockquotes
  result = result.replace(/^&gt; (.+)$/gm, '<blockquote class="border-l-2 border-gray-700 pl-3 text-gray-500 my-2">$1</blockquote>');

  // Paragraphs
  result = result
    .replace(/\n\n/g, "</p><p class=\"mb-2 text-xs leading-relaxed\">")
    .replace(/^/, '<p class="mb-2 text-xs leading-relaxed">') + "</p>";

  // Restore code blocks
  result = result.replace(/\x00CODE(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)]!);

  return result;
}
