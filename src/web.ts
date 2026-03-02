import { resolve } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { createAgent, ALL_AGENTS, AGENT_LABELS, type AgentType, type AgentLabel, type Agent } from "./agent";
import {
  buildAnalystChatPrompt,
  buildRound1Prompt,
  buildRound2Prompt,
  buildRound3Prompt,
  buildRoundSummaryPrompt,
  buildFinalReportPrompt,
  DETECT_LANGUAGE_PROMPT,
  type RoundHistory,
} from "./prompts";

const PORT = Number(process.env.PORT) || 3000;

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

type WS = { send(data: string): void };

function send(ws: WS, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg));
}

function parseAnalystOutput(output: string): { name: string; problem: string } {
  const nameMatch = output.match(/---NAME---\s*\n([^\n]+)/);
  const problemMatch = output.match(/---PROBLEM---\s*\n([\s\S]+)$/);
  const name = nameMatch?.[1]?.trim() || "unknown-problem";
  const problem = problemMatch?.[1]?.trim() || output;
  return { name, problem };
}

// ── WebSocket state ──

interface SessionConfig {
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

interface WSState {
  config: SessionConfig | null;
  analystAgent: Agent | null;
  chatHistory: Array<{ role: "user" | "assistant"; text: string }>;
  sessionName: string | null;
  sessionDir: string | null;
  lang: string | null;
  meta: SessionMeta | null;
  continueResolve: (() => void) | null;
}

const wsStates = new Map<unknown, WSState>();

function newState(): WSState {
  return { config: null, analystAgent: null, chatHistory: [], sessionName: null, sessionDir: null, lang: null, meta: null, continueResolve: null };
}

async function saveMeta(state: WSState) {
  if (state.meta && state.sessionDir) {
    await writeFileSafe(resolve(state.sessionDir, "meta.json"), JSON.stringify(state.meta, null, 2));
  }
}

function waitForContinue(ws: WS, state: WSState, round: number): Promise<void> {
  send(ws, { type: "round-done", round });
  return new Promise((resolve) => { state.continueResolve = resolve; });
}

// ── Analyst chat ──

async function detectLanguage(text: string, model: AgentType): Promise<string> {
  const agent = createAgent(model, process.cwd());
  try {
    const raw = await agent.prompt(DETECT_LANGUAGE_PROMPT + text.slice(0, 500));
    return raw.trim().split("\n")[0]!.trim();
  } finally {
    await agent.close();
  }
}

async function handleAnalystChat(ws: WS, state: WSState, text: string) {
  state.chatHistory.push({ role: "user", text });

  // Detect language on first user message
  if (!state.lang && state.chatHistory.length === 1) {
    try {
      state.lang = await detectLanguage(text, state.config!.analyst);
      send(ws, { type: "lang", lang: state.lang });
    } catch { /* non-critical, default to English */ }
  }

  if (!state.analystAgent) {
    state.analystAgent = createAgent(state.config!.analyst, process.cwd(), (chunk) => {
      send(ws, { type: "chat-chunk", text: chunk });
    });
  }

  const prompt = buildAnalystChatPrompt(state.chatHistory, state.lang || undefined);
  const response = await state.analystAgent.prompt(prompt);
  state.chatHistory.push({ role: "assistant", text: response });
  send(ws, { type: "chat-done", text: response });
}

// ── Run: finalize problem → start consensus ──

async function handleRun(ws: WS, state: WSState) {
  send(ws, { type: "status", text: "Finalizing problem..." });

  const finalPrompt = buildAnalystChatPrompt(state.chatHistory, state.lang || undefined) +
    "\n\nThe user is ready. Output the final structured problem now using the ---NAME--- and ---PROBLEM--- format.";

  const output = await state.analystAgent!.prompt(finalPrompt);
  await state.analystAgent!.close();
  state.analystAgent = null;

  const { name, problem } = parseAnalystOutput(output);
  const date = new Date().toISOString().slice(0, 10);
  state.sessionName = `${date}-${name}`;
  state.sessionDir = resolve(process.cwd(), "sessions", state.sessionName);

  // If language wasn't detected during chat, detect from problem
  if (!state.lang) {
    try {
      state.lang = await detectLanguage(problem, state.config!.analyst);
      send(ws, { type: "lang", lang: state.lang });
    } catch { /* non-critical */ }
  }

  await ensureDir(state.sessionDir);
  await writeFileSafe(resolve(state.sessionDir, "problem.md"), problem);
  send(ws, { type: "artifact", path: "problem.md" });
  send(ws, { type: "problem-ready", name: state.sessionName, problem });

  const lang = state.lang || undefined;
  await runConsensusWS(ws, state, problem, state.config!, state.sessionName, state.sessionDir, lang);
}

// ── Resume: re-run consensus on existing session ──

async function handleResume(ws: WS, state: WSState, sessionName: string) {
  const baseDir = resolve(process.cwd(), "sessions", sessionName);

  // Read problem
  let problem: string;
  try {
    problem = await Bun.file(resolve(baseDir, "problem.md")).text();
  } catch {
    send(ws, { type: "error", text: `Session ${sessionName} has no problem.md` });
    return;
  }

  state.sessionName = sessionName;
  state.sessionDir = baseDir;

  // Detect language from problem text
  try {
    state.lang = await detectLanguage(problem, state.config!.analyst);
    send(ws, { type: "lang", lang: state.lang });
  } catch { /* non-critical */ }

  send(ws, { type: "problem-ready", name: sessionName, problem });
  const lang = state.lang || undefined;
  await runConsensusWS(ws, state, problem, state.config!, sessionName, baseDir, lang);
}

// ── Consensus pipeline (resilient, resumable) ──

/** Try to read an existing solution from disk */
async function readExisting(baseDir: string, round: number, label: string): Promise<string | null> {
  try {
    return await Bun.file(resolve(baseDir, `r${round}`, label, "solution.md")).text();
  } catch {
    return null;
  }
}

/** Load all existing solutions for a round from disk */
async function loadRoundSolutions(baseDir: string, round: number, labels: string[]): Promise<Map<string, string>> {
  const solutions = new Map<string, string>();
  for (const label of labels) {
    const existing = await readExisting(baseDir, round, label);
    if (existing) solutions.set(label, existing);
  }
  return solutions;
}

/** Run agents in parallel with allSettled — survivors continue even if one dies */
async function runAgentsSettled(
  ws: WS,
  round: number,
  agents: Map<AgentLabel, Agent>,
  labels: string[],
  baseDir: string,
  solutions: Map<string, string>,
  buildPrompt: (label: string, agent: Agent) => string,
  roundMeta: RoundTiming,
): Promise<string[]> {
  const failed: string[] = [];

  const results = await Promise.allSettled(
    labels.map(async (label) => {
      // Skip if solution already on disk
      const existing = await readExisting(baseDir, round, label);
      if (existing) {
        solutions.set(label, existing);
        const size = Math.round(existing.length / 1024);
        roundMeta.agents.push({ name: agents.get(label as AgentLabel)!.name, label, elapsed: "cached", size, status: "cached" });
        send(ws, { type: "agent-done", round, label, name: agents.get(label as AgentLabel)!.name, elapsed: "cached", size });
        return;
      }

      const agent = agents.get(label as AgentLabel)!;
      const dir = resolve(baseDir, `r${round}`, label);
      await ensureDir(dir);
      send(ws, { type: "agent-start", round, label, name: agent.name });

      const start = Date.now();
      const prompt = buildPrompt(label, agent);
      await writeFileSafe(resolve(dir, "prompt.md"), prompt);
      send(ws, { type: "artifact", path: `r${round}/${label}/prompt.md` });
      const output = await agent.prompt(prompt);
      await writeFileSafe(resolve(dir, "solution.md"), output);
      solutions.set(label, output);
      const elapsedStr = elapsed(start);
      const size = Math.round(output.length / 1024);
      roundMeta.agents.push({ name: agent.name, label, elapsed: elapsedStr, size, status: "ok" });
      send(ws, { type: "artifact", path: `r${round}/${label}/solution.md` });
      send(ws, { type: "agent-done", round, label, name: agent.name, elapsed: elapsedStr, size });
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      const label = labels[i]!;
      const agent = agents.get(label as AgentLabel)!;
      failed.push(label);
      roundMeta.agents.push({ name: agent.name, label, elapsed: "0s", size: 0, status: "failed" });
      send(ws, { type: "agent-failed", round, label, name: agent.name, error: r.reason?.message || String(r.reason) });
    }
  }

  return failed;
}

async function runConsensusWS(
  ws: WS,
  state: WSState,
  problem: string,
  config: SessionConfig,
  sessionName: string,
  baseDir: string,
  lang?: string,
) {
  const sessionStart = Date.now();
  state.meta = {
    startedAt: new Date().toISOString(),
    lang: lang,
    config: config,
    rounds: [],
  };
  await saveMeta(state);

  send(ws, { type: "status", text: `Session: ${sessionName}` });
  send(ws, { type: "status", text: `Agents: ${config.participants.join(", ")}` });

  const assignment = assignAgents(config.participants);
  const agents = new Map<AgentLabel, Agent>();

  // Save assignment so resume can reuse it
  const assignmentFile = resolve(baseDir, "assignment.json");
  const assignmentData = Object.fromEntries(assignment);
  await writeFileSafe(assignmentFile, JSON.stringify(assignmentData));

  send(ws, { type: "status", text: "Starting agents..." });
  for (const [label, agentType] of assignment) {
    agents.set(label, createAgent(agentType, baseDir));
    send(ws, { type: "agent-init", label, name: agentType });
  }

  const labels = [...agents.keys()];
  let allFailed: string[] = [];

  /** Run a round, record timing, save meta, pause for user */
  async function executeRound(
    round: number,
    title: string,
    buildPrompt: (label: string, agent: Agent) => string,
  ): Promise<{ solutions: Map<string, string>; failed: string[] }> {
    const roundStart = Date.now();
    const roundMeta: RoundTiming = { round, title, startedAt: new Date().toISOString(), agents: [] };
    state.meta!.rounds.push(roundMeta);

    send(ws, { type: "round-start", round, title });
    const solutions = new Map<string, string>();
    const failed = await runAgentsSettled(ws, round, agents, labels, baseDir, solutions, buildPrompt, roundMeta);

    if (solutions.size > 0) await roundSummary(ws, solutions, round, config.supervisor, baseDir, lang);

    roundMeta.completedAt = new Date().toISOString();
    roundMeta.elapsedMs = Date.now() - roundStart;
    send(ws, { type: "round-elapsed", round, elapsedMs: roundMeta.elapsedMs });
    await saveMeta(state);

    // Pause — wait for user to continue (unless it's the last step before report)
    if (round < 3) {
      await waitForContinue(ws, state, round);
    }

    return { solutions, failed };
  }

  const allRounds: RoundHistory[] = [];

  try {
    // ── Round 1: Solve ──
    let { solutions, failed } = await executeRound(1, "Solve", () => buildRound1Prompt(problem, lang));
    allFailed.push(...failed.map(l => `r1:${l}`));
    allRounds.push({ round: 1, title: "Solve", solutions: new Map(solutions) });

    // ── Round 2: Improve ──
    const r1Solutions = solutions;
    ({ solutions, failed } = await executeRound(2, "Improve", (label) => {
      const otherLabels = shuffle(labels.filter((l) => l !== label));
      const peerSolutions = otherLabels.map((l) => r1Solutions.get(l)!).filter(Boolean);
      return buildRound2Prompt(problem, peerSolutions, lang);
    }));
    allFailed.push(...failed.map(l => `r2:${l}`));
    allRounds.push({ round: 2, title: "Improve", solutions: new Map(solutions) });

    // ── Round 3: Defend ──
    const r2Solutions = solutions;
    ({ solutions, failed } = await executeRound(3, "Defend", (label) => {
      const ownSolution = r2Solutions.get(label) || "";
      const otherLabels = shuffle(labels.filter((l) => l !== label));
      const peerSolutions = otherLabels.map((l) => r2Solutions.get(l)!).filter(Boolean);
      return buildRound3Prompt(problem, ownSolution, peerSolutions, lang);
    }));
    allFailed.push(...failed.map(l => `r3:${l}`));
    allRounds.push({ round: 3, title: "Defend", solutions: new Map(solutions) });

    // ── Final Report ──
    if (await Bun.file(resolve(baseDir, "final-report.md")).exists()) {
      const existing = await Bun.file(resolve(baseDir, "final-report.md")).text();
      send(ws, { type: "final-report", text: existing });
      send(ws, { type: "status", text: "Final report already exists (cached)" });
    } else if (solutions.size > 0) {
      send(ws, { type: "round-start", round: "final", title: "Final Report" });
      const reportStart = Date.now();
      const reportDir = resolve(baseDir, "final");
      await ensureDir(reportDir);
      await writeFileSafe(resolve(reportDir, "problem.md"), problem);
      for (const [label, text] of solutions) {
        await writeFileSafe(resolve(reportDir, `solution-${label}.md`), text);
      }

      const reporter = createAgent(config.reporter, process.cwd());
      try {
        const report = await reporter.prompt(buildFinalReportPrompt(problem, allRounds, lang));
        await writeFileSafe(resolve(baseDir, "final-report.md"), report);
        await writeFileSafe(resolve(reportDir, "final-report.md"), report);
        send(ws, { type: "artifact", path: "final-report.md" });
        send(ws, { type: "final-report", text: report });
        send(ws, { type: "round-elapsed", round: "final", elapsedMs: Date.now() - reportStart });
      } finally {
        await reporter.close();
      }
    }

    state.meta!.completedAt = new Date().toISOString();
    state.meta!.totalElapsedMs = Date.now() - sessionStart;
    await saveMeta(state);

    if (allFailed.length > 0) {
      send(ws, { type: "partial-done", session: sessionName, failed: allFailed, totalElapsedMs: state.meta!.totalElapsedMs });
    } else {
      send(ws, { type: "done", session: sessionName, totalElapsedMs: state.meta!.totalElapsedMs });
    }
  } catch (err: any) {
    send(ws, { type: "error", text: err.message || String(err) });
  } finally {
    await Promise.all([...agents.values()].map((a) => a.close()));
  }
}

async function roundSummary(ws: WS, solutions: Map<string, string>, round: number, model: AgentType, baseDir: string, lang?: string) {
  send(ws, { type: "status", text: `Summarizing round ${round}...` });
  const summarizer = createAgent(model, process.cwd());
  try {
    const summary = await summarizer.prompt(buildRoundSummaryPrompt(solutions, lang));
    await writeFileSafe(resolve(baseDir, `r${round}`, "summary.md"), summary);
    send(ws, { type: "artifact", path: `r${round}/summary.md` });
    send(ws, { type: "round-summary", round, text: summary });
  } finally {
    await summarizer.close();
  }
}

// ── Sessions & Artifacts API ──

interface SessionInfo {
  name: string;
  hasReport: boolean;
  problem: string;
  rounds: number;
  agents: string[];
  totalElapsedMs?: number;
}

async function listSessions(): Promise<SessionInfo[]> {
  const dir = resolve(process.cwd(), "sessions");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const sessions: SessionInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const sdir = resolve(dir, name);
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

      sessions.push({ name, hasReport, problem, rounds, agents, totalElapsedMs });
    }
    sessions.sort((a, b) => b.name.localeCompare(a.name));
    return sessions;
  } catch {
    return [];
  }
}

interface Artifact { path: string; type: string; round?: number; label?: string }

async function getSessionAssignment(name: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Bun.file(resolve(process.cwd(), "sessions", name, "assignment.json")).text());
  } catch {
    return {};
  }
}

async function listSessionArtifacts(name: string): Promise<Artifact[]> {
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

// ── HTML ──

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consilium</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #e6edf3; --dim: #8b949e; --accent: #58a6ff;
  --green: #3fb950; --yellow: #d29922; --red: #f85149; --cyan: #79c0ff;
  --font: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
}
body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.6; }

header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 12px; }
header h1 { font-size: 18px; font-weight: 600; cursor: pointer; }
header h1:hover { color: var(--accent); }
header .sub { color: var(--dim); font-size: 12px; }
header nav { margin-left: auto; font-size: 12px; }
header nav a { color: var(--dim); text-decoration: none; margin-left: 16px; }
header nav a:hover { color: var(--accent); }

/* Shared */
.form-section { margin-bottom: 14px; }
.form-section label { display: block; color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.btn { padding: 7px 20px; background: var(--accent); color: #000; border: none; border-radius: 5px; font-family: var(--font); font-size: 13px; font-weight: 600; cursor: pointer; }
.btn:hover { opacity: 0.85; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-green { background: var(--green); }
.btn-small { padding: 3px 10px; font-size: 11px; }
select { padding: 6px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--font); font-size: 13px; }
select:focus { outline: none; border-color: var(--accent); }
.spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 4px; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

/* Main layout: sidebar + content */
.main { display: flex; height: calc(100vh - 52px); }
.sidebar { width: 220px; flex-shrink: 0; border-right: 1px solid var(--border); overflow-y: auto; padding: 12px 0; }
.content { flex: 1; min-width: 0; overflow-y: auto; padding: 20px; }

/* Sidebar sections */
.sidebar-section { padding: 0 12px; margin-bottom: 16px; }
.sidebar-section h3 { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.artifact-group { margin-bottom: 12px; }
.artifact-group-title { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; padding-left: 8px; }
.artifact-item { display: block; width: 100%; text-align: left; padding: 4px 8px; cursor: pointer; border-radius: 4px; font-size: 12px; color: var(--dim); background: none; border: none; font-family: var(--font); }
.artifact-item:hover { background: var(--surface); color: var(--text); }
.artifact-item.active { background: rgba(88,166,255,0.1); color: var(--accent); border-left: 2px solid var(--accent); }
.artifact-summary { color: var(--yellow); font-style: italic; }
.model-reveal { display: inline-block; background: var(--surface); color: var(--dim); border-radius: 3px; padding: 0 4px; font-size: 10px; cursor: pointer; margin-left: 4px; }
.model-reveal:hover { color: var(--accent); }
.prompt-toggle { cursor: pointer; color: var(--dim); font-size: 11px; margin-left: 4px; }
.prompt-toggle:hover { color: var(--yellow); }
.session-link { display: block; padding: 6px 8px; font-size: 11px; color: var(--dim); cursor: pointer; border-radius: 4px; text-decoration: none; border: none; background: none; width: 100%; text-align: left; font-family: var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-link:hover { background: var(--surface); color: var(--text); }
.session-link.active { color: var(--accent); }
.new-session-btn { display: block; width: calc(100% - 24px); margin: 0 12px 12px; padding: 6px; background: var(--surface); border: 1px dashed var(--border); border-radius: 4px; color: var(--dim); font-family: var(--font); font-size: 12px; cursor: pointer; text-align: center; }
.new-session-btn:hover { border-color: var(--accent); color: var(--accent); }

/* Setup form */
.setup-form { max-width: 600px; }
.agents-row { display: flex; gap: 6px; flex-wrap: wrap; }
.agent-toggle { padding: 5px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; color: var(--dim); cursor: pointer; font-family: var(--font); font-size: 12px; }
.agent-toggle.active { border-color: var(--accent); color: var(--accent); background: rgba(88,166,255,0.1); }
.roles-row { display: flex; gap: 16px; margin-bottom: 14px; }
.roles-row .form-section { flex: 1; }

/* Chat */
#chat-messages { max-height: 45vh; overflow-y: auto; margin-bottom: 12px; }
.chat-msg { padding: 8px 12px; margin: 6px 0; border-radius: 6px; max-width: 85%; font-size: 13px; line-height: 1.5; word-wrap: break-word; }
.chat-msg.user { background: rgba(88,166,255,0.12); margin-left: auto; }
.chat-msg.assistant { background: var(--surface); border: 1px solid var(--border); }
.chat-input-row { display: flex; gap: 8px; align-items: flex-end; }
.chat-input-row textarea { flex: 1; min-height: 38px; max-height: 120px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: var(--font); font-size: 13px; resize: none; }
.chat-input-row textarea:focus { outline: none; border-color: var(--accent); }

/* Progress log */
.log-entry { padding: 3px 0; font-size: 12px; color: var(--dim); animation: fadeIn 0.15s; }
.log-entry.round-start { color: var(--text); font-weight: 600; margin-top: 12px; font-size: 13px; }
.log-entry.agent-start { color: var(--dim); padding-left: 12px; }
.log-entry.agent-done { color: var(--green); padding-left: 12px; }
.log-entry.agent-failed { color: var(--red); padding-left: 12px; }
.log-entry.error { color: var(--red); }
.log-entry.timing { color: var(--cyan); font-size: 11px; padding-left: 12px; }
.summary-block { margin: 8px 0 16px 0; padding: 10px 14px; background: var(--surface); border-left: 3px solid var(--yellow); border-radius: 0 6px 6px 0; font-size: 12px; }
.continue-block { margin: 12px 0; padding: 12px 16px; background: var(--surface); border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--text); }
.continue-block .btn { flex-shrink: 0; }

/* Artifact viewer */
#artifact-content { padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; min-height: 200px; line-height: 1.7; }

/* Markdown */
.md h2 { color: var(--accent); margin: 18px 0 6px 0; font-size: 15px; }
.md h2:first-child { margin-top: 0; }
.md h3 { color: var(--text); margin: 14px 0 4px 0; font-size: 13px; }
.md p { margin-bottom: 8px; }
.md ul, .md ol { padding-left: 18px; margin-bottom: 8px; }
.md table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12px; }
.md th, .md td { border: 1px solid var(--border); padding: 5px 8px; text-align: left; }
.md th { background: rgba(88,166,255,0.1); color: var(--accent); }
.md code { background: rgba(110,118,129,0.2); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.md pre { background: rgba(110,118,129,0.15); padding: 10px; border-radius: 5px; overflow-x: auto; margin: 8px 0; }
.md pre code { background: none; padding: 0; }
.md blockquote { border-left: 3px solid var(--border); padding-left: 10px; color: var(--dim); margin: 8px 0; }

/* Content views - only one visible at a time */
.view { display: none; }
.view.active { display: block; }
</style>
</head>
<body>

<header>
  <h1 onclick="navigate('/');route()">consilium</h1>
  <span class="sub">multi-agent deliberation</span>
  <nav>
    <a href="/sessions/new" onclick="event.preventDefault();navigate('/sessions/new');route()">+ new</a>
    <a href="/" onclick="event.preventDefault();navigate('/');route()">sessions</a>
  </nav>
</header>

<div class="main">
  <!-- Left sidebar: artifacts tree (grows live during consensus) -->
  <div class="sidebar" id="sidebar">
    <button class="new-session-btn" onclick="navigate('/sessions/new');route()">+ new session</button>
    <div class="sidebar-section" id="artifacts-sidebar"></div>
    <div class="sidebar-section" id="sessions-sidebar"></div>
  </div>

  <!-- Right content area -->
  <div class="content" id="content">

    <!-- View: Sessions list -->
    <div class="view" id="view-sessions">
      <div id="sessions-list"></div>
    </div>

    <!-- View: New session (setup + chat + log — all stacked) -->
    <div class="view" id="view-new">
      <div class="setup-form" id="setup-section">
        <div class="form-section">
          <label>Participants</label>
          <div class="agents-row" id="agents-row"></div>
        </div>
        <div class="roles-row">
          <div class="form-section"><label>Analyst</label><select id="sel-analyst"></select></div>
          <div class="form-section"><label>Supervisor</label><select id="sel-supervisor"></select></div>
          <div class="form-section"><label>Reporter</label><select id="sel-reporter"></select></div>
        </div>
        <button class="btn" onclick="startSession()">Start</button>
      </div>

      <div id="chat-section" style="display:none; margin-top:20px;">
        <div id="chat-messages"></div>
        <div class="chat-input-row">
          <textarea id="chat-input" placeholder="Describe your problem..." rows="2"></textarea>
          <button class="btn" id="send-btn" onclick="sendChat()">Send</button>
          <button class="btn btn-green" id="run-btn" onclick="runConsensus()">Run</button>
        </div>
      </div>

      <div id="log-section" style="display:none; margin-top:20px; border-top:1px solid var(--border); padding-top:12px;">
        <div id="log"></div>
      </div>
    </div>

    <!-- View: Session detail (artifact viewer) -->
    <div class="view" id="view-session">
      <div id="artifact-content" class="md"></div>
    </div>

  </div>
</div>

<script>
var ALL = ['claude','codex','gemini','kimi','opencode'];
var selected = new Set(ALL);
var ws = null;
var curView = 'new';
var streamEl = null;
var streamRaw = '';
var sessionsData = [];
var activeSessionName = null;
var currentSessionName = null;
var currentAssignment = {};

// ── Navigation ──
function navigate(path, replace) {
  if (location.pathname !== path) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
  }
}

function setView(v) {
  curView = v;
  ['sessions','new','session'].forEach(function(id) {
    var el = document.getElementById('view-' + id);
    if (el) el.className = 'view' + (id === v ? ' active' : '');
  });
  // Sessions sidebar only on home
  var ss = document.getElementById('sessions-sidebar');
  if (ss) ss.style.display = (v === 'sessions') ? '' : 'none';
}

window.addEventListener('popstate', function() { route(); });

// ── Setup ──
function renderAgents() {
  var row = document.getElementById('agents-row');
  if (!row) return;
  row.innerHTML = '';
  ALL.forEach(function(name) {
    var b = document.createElement('button');
    b.className = 'agent-toggle' + (selected.has(name) ? ' active' : '');
    b.textContent = name;
    b.onclick = function() {
      if (selected.has(name) && selected.size > 1) selected.delete(name);
      else selected.add(name);
      renderAgents();
    };
    row.appendChild(b);
  });
}

function renderSelects() {
  ['sel-analyst','sel-supervisor','sel-reporter'].forEach(function(id) {
    var sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = ALL.map(function(n) {
      return '<option value="' + n + '"' + (n === 'claude' ? ' selected' : '') + '>' + n + '</option>';
    }).join('');
  });
}

// ── Minimal markdown ──
function md(text) {
  if (!text) return '';
  var h = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>')
    .replace(/^\\|(.+)\\|$/gm, function(m, inner) {
      var cells = inner.split('|').map(function(c){return c.trim()});
      if (cells.every(function(c){return /^[-:]+$/.test(c)})) return '';
      return '<tr>' + cells.map(function(c){return '<td>'+c+'</td>'}).join('') + '</tr>';
    })
    .replace(/\\n\\n/g, '</p><p>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  h = h.replace(/(<li>[\\s\\S]*?<\\/li>\\s*)+/g, '<ul>$&</ul>');
  h = h.replace(/(<tr>[\\s\\S]*?<\\/tr>\\s*)+/g, '<table>$&</table>');
  return '<p>' + h + '</p>';
}

function esc(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }

function formatMs(ms) {
  if (!ms) return '?';
  var sec = Math.round(ms / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  return min + 'm' + (sec % 60) + 's';
}

// ── Chat ──
function addChatMsg(role, html) {
  var el = document.createElement('div');
  el.className = 'chat-msg ' + role;
  el.innerHTML = html;
  document.getElementById('chat-messages').appendChild(el);
  el.scrollIntoView({behavior:'smooth',block:'nearest'});
  return el;
}

function startSession() {
  // Hide setup, show chat
  document.getElementById('setup-section').style.display = 'none';
  document.getElementById('chat-section').style.display = 'block';

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onopen = function() {
    ws.send(JSON.stringify({
      type: 'start',
      agents: Array.from(selected),
      analyst: document.getElementById('sel-analyst').value,
      supervisor: document.getElementById('sel-supervisor').value,
      reporter: document.getElementById('sel-reporter').value
    }));
  };
  ws.onmessage = handleMsg;
  ws.onclose = function() {
    if (curView === 'new') addLog('error', 'Connection lost');
  };
}

function sendChat() {
  var inp = document.getElementById('chat-input');
  var text = inp.value.trim();
  if (!text || !ws) return;
  inp.value = '';
  inp.style.height = '38px';
  addChatMsg('user', esc(text));
  ws.send(JSON.stringify({ type: 'chat', text: text }));
  document.getElementById('send-btn').disabled = true;
  document.getElementById('run-btn').disabled = true;
  streamEl = addChatMsg('assistant', '<span class="spinner"></span>');
  streamRaw = '';
}

function runConsensus() {
  if (!ws) return;
  document.getElementById('send-btn').disabled = true;
  document.getElementById('run-btn').disabled = true;
  ws.send(JSON.stringify({ type: 'run' }));
}

function sendContinue() {
  if (!ws) return;
  var cb = document.getElementById('continue-block');
  if (cb) cb.remove();
  ws.send(JSON.stringify({ type: 'continue' }));
}

// ── Auto-resize textarea ──
document.addEventListener('DOMContentLoaded', function() {
  var ta = document.getElementById('chat-input');
  if (ta) {
    ta.addEventListener('input', function() {
      this.style.height = '38px';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    ta.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
  }
});

// ── Log ──
function addLog(cls, html) {
  var el = document.createElement('div');
  el.className = 'log-entry ' + cls;
  el.innerHTML = html;
  document.getElementById('log').appendChild(el);
  el.scrollIntoView({behavior:'smooth',block:'nearest'});
}

// ── WS message handler ──
function handleMsg(ev) {
  var msg = JSON.parse(ev.data);
  switch(msg.type) {
    case 'config-ok': break;

    case 'chat-chunk':
      if (streamEl) { streamRaw += msg.text; streamEl.innerHTML = md(streamRaw); }
      break;

    case 'chat-done':
      if (streamEl) { streamEl.innerHTML = md(msg.text); streamEl = null; streamRaw = ''; }
      document.getElementById('send-btn').disabled = false;
      document.getElementById('run-btn').disabled = false;
      break;

    case 'problem-ready':
      currentSessionName = msg.name;
      // Show log section, hide chat input
      document.getElementById('log-section').style.display = 'block';
      document.getElementById('chat-section').style.display = 'none';
      addLog('status', 'Session: ' + esc(msg.name));
      // Navigate to session URL
      navigate('/sessions/' + encodeURIComponent(msg.name));
      break;

    case 'artifact':
      // Refresh sidebar artifacts live
      if (currentSessionName) refreshArtifacts(currentSessionName);
      break;

    case 'status': addLog('status', msg.text); break;
    case 'round-start': addLog('round-start', '=== Round ' + msg.round + ': ' + msg.title + ' ==='); break;
    case 'agent-init': addLog('status', '  ' + msg.name + ' (' + msg.label + ') ready'); break;
    case 'agent-start': addLog('agent-start', '<span class="spinner"></span> ' + msg.name + ' working...'); break;

    case 'agent-done':
      var entries = document.querySelectorAll('.log-entry.agent-start');
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].textContent.indexOf(msg.name + ' working') >= 0) { entries[i].remove(); break; }
      }
      addLog('agent-done', '&#10003; ' + msg.name + ' (' + msg.elapsed + ', ' + msg.size + 'kb)');
      break;

    case 'agent-failed':
      var entries2 = document.querySelectorAll('.log-entry.agent-start');
      for (var i = 0; i < entries2.length; i++) {
        if (entries2[i].textContent.indexOf(msg.name + ' working') >= 0) { entries2[i].remove(); break; }
      }
      addLog('agent-failed', '&#10007; ' + msg.name + ' failed: ' + esc(msg.error));
      break;

    case 'round-summary':
      var bl = document.createElement('div');
      bl.className = 'summary-block';
      bl.textContent = msg.text;
      document.getElementById('log').appendChild(bl);
      break;

    case 'round-elapsed':
      addLog('timing', 'Round ' + msg.round + ' completed in ' + formatMs(msg.elapsedMs));
      break;

    case 'round-done':
      var cdiv = document.createElement('div');
      cdiv.className = 'continue-block';
      cdiv.id = 'continue-block';
      var nextRound = msg.round + 1;
      var nextName = {2:'Improve', 3:'Defend'}[nextRound] || 'Round ' + nextRound;
      cdiv.innerHTML = '<span>Round ' + msg.round + ' complete.</span> ' +
        '<button class="btn" onclick="sendContinue()">Continue to ' + nextName + '</button>';
      document.getElementById('log').appendChild(cdiv);
      cdiv.scrollIntoView({behavior:'smooth',block:'nearest'});
      break;

    case 'final-report': break;

    case 'partial-done':
    case 'done':
      if (msg.totalElapsedMs) addLog('timing', 'Total: ' + formatMs(msg.totalElapsedMs));
      addLog('status', msg.type === 'done' ? 'Done!' : 'Partial. Failed: ' + (msg.failed||[]).join(', '));
      activeSessionName = msg.session;
      if (msg.session) refreshArtifacts(msg.session);
      // Switch to artifact view after short delay so user sees "Done!"
      setTimeout(function() {
        setView('session');
        currentSessionName = null;
        ws = null;
        var report = document.querySelector('.artifact-item[data-path="final-report.md"]');
        if (report) report.click();
      }, 1500);
      break;

    case 'error':
      addLog('error', 'Error: ' + msg.text);
      document.getElementById('send-btn').disabled = false;
      document.getElementById('run-btn').disabled = false;
      break;

    case 'lang': break;
  }
}

// ── Artifacts ──
var refreshTimer = null;
function refreshArtifacts(name) {
  // Debounce to avoid flooding during rapid artifact events
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function() { loadArtifacts(name); }, 300);
}

function loadArtifacts(sessionName) {
  fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/artifacts')
    .then(function(r){return r.json()})
    .then(function(data){
      currentAssignment = data.assignment || {};
      renderArtifacts(sessionName, data.artifacts || []);
    });
}

function renderArtifacts(sessionName, list) {
  var groups = {
    'Problem': list.filter(function(a){return a.type==='problem'}),
    'Round 1 — Solve': list.filter(function(a){return a.round===1 && a.type!=='prompt'}),
    'Round 2 — Improve': list.filter(function(a){return a.round===2 && a.type!=='prompt'}),
    'Round 3 — Defend': list.filter(function(a){return a.round===3 && a.type!=='prompt'}),
    'Final Report': list.filter(function(a){return a.type==='report'})
  };
  var prompts = list.filter(function(a){return a.type==='prompt'});
  var html = '';
  for (var title in groups) {
    var items = groups[title];
    if (!items.length) continue;
    html += '<div class="artifact-group"><div class="artifact-group-title">' + title + '</div>';
    items.forEach(function(item) {
      var label, cls = 'artifact-item';
      if (item.type === 'summary') {
        label = 'summary'; cls += ' artifact-summary';
      } else if (item.label) {
        label = 'agent ' + item.label;
        var hasPrompt = prompts.some(function(p){ return p.round === item.round && p.label === item.label; });
        if (hasPrompt) {
          label += ' <span class="prompt-toggle" onclick="event.stopPropagation();viewArtifact(\\'' + esc(sessionName) + '\\',\\'' + esc('r' + item.round + '/' + item.label + '/prompt.md') + '\\')" title="view prompt">&#9881;</span>';
        }
      } else {
        label = item.path.split('/').pop();
      }
      var modelInfo = '';
      if (item.label && currentAssignment[item.label]) {
        modelInfo = ' <span class="model-reveal" onclick="event.stopPropagation();this.textContent=\\'' + esc(currentAssignment[item.label]) + '\\'" title="reveal model">?</span>';
      }
      html += '<button class="' + cls + '" data-path="' + esc(item.path) + '" onclick="viewArtifact(\\'' + esc(sessionName) + '\\',\\'' + esc(item.path) + '\\')">' + label + modelInfo + '</button>';
    });
    html += '</div>';
  }
  document.getElementById('artifacts-sidebar').innerHTML = html;
}

function viewArtifact(sessionName, path) {
  // Switch to session view to show artifact content
  setView('session');
  activeSessionName = sessionName;
  document.querySelectorAll('.artifact-item').forEach(function(el){el.classList.remove('active')});
  document.querySelectorAll('.artifact-item').forEach(function(el){
    if (el.getAttribute('data-path') === path) el.classList.add('active');
  });
  document.getElementById('artifact-content').innerHTML = '<span class="spinner"></span> Loading...';
  fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/artifact/' + encodeURIComponent(path))
    .then(function(r){return r.text()})
    .then(function(text){ document.getElementById('artifact-content').innerHTML = md(text); })
    .catch(function(){ document.getElementById('artifact-content').innerHTML = '<p style="color:var(--red)">Failed to load</p>'; });
}

// ── Sessions ──
function loadSessions() {
  fetch('/api/sessions').then(function(r){return r.json()}).then(function(data){
    sessionsData = data;
    renderSessionsSidebar();
    if (curView === 'sessions') renderSessionsList();
  }).catch(function(){});
}

function renderSessionsSidebar() {
  var html = '<h3>Sessions</h3>';
  sessionsData.forEach(function(s) {
    var cls = 'session-link' + (activeSessionName === s.name ? ' active' : '');
    var badge = s.hasReport ? ' &#10003;' : '';
    html += '<button class="' + cls + '" onclick="openSession(\\'' + esc(s.name) + '\\')" title="' + esc(s.name) + '">' + esc(s.name.replace(/^\\d{4}-\\d{2}-\\d{2}-/, '')) + badge + '</button>';
  });
  if (!sessionsData.length) html += '<p style="color:var(--dim);font-size:11px;padding:0 8px;">No sessions yet</p>';
  document.getElementById('sessions-sidebar').innerHTML = html;
}

function renderSessionsList() {
  if (!sessionsData.length) {
    document.getElementById('sessions-list').innerHTML = '<p style="color:var(--dim)">No sessions yet. Start a new one!</p>';
    return;
  }
  var html = '';
  sessionsData.forEach(function(s) {
    var badge = s.hasReport ? '<span style="color:var(--green);font-size:10px;margin-left:6px;">complete</span>'
      : (s.rounds > 0 ? '<span style="color:var(--yellow);font-size:10px;margin-left:6px;">round ' + s.rounds + '</span>' : '');
    var meta = '';
    if (s.totalElapsedMs) meta += formatMs(s.totalElapsedMs);
    if (s.agents.length) meta += (meta ? ' · ' : '') + s.agents.join(', ');
    var resumeBtn = (!s.hasReport && s.rounds > 0)
      ? ' <button class="btn btn-small" onclick="event.stopPropagation();resumeSession(\\'' + esc(s.name) + '\\')">Resume</button>' : '';
    html += '<div style="padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:5px;margin-bottom:6px;cursor:pointer;" onclick="openSession(\\'' + esc(s.name) + '\\')">' +
      '<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:12px;font-weight:600;">' + esc(s.name) + '</span>' + badge + resumeBtn + '</div>' +
      (meta ? '<div style="color:var(--dim);font-size:10px;">' + meta + '</div>' : '') +
      (s.problem ? '<div style="color:var(--dim);font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">' + esc(s.problem) + '</div>' : '') +
      '</div>';
  });
  document.getElementById('sessions-list').innerHTML = html;
}

function openSession(name) {
  activeSessionName = name;
  navigate('/sessions/' + encodeURIComponent(name));
  showSession(name);
}

function showSession(name) {
  // If this is the running session, show progress log
  if (currentSessionName === name && ws && ws.readyState === WebSocket.OPEN) {
    setView('new');
    document.getElementById('setup-section').style.display = 'none';
    document.getElementById('chat-section').style.display = 'none';
    document.getElementById('log-section').style.display = 'block';
    // Scroll log to bottom so user sees latest state
    var log = document.getElementById('log');
    if (log && log.lastElementChild) log.lastElementChild.scrollIntoView({behavior:'smooth',block:'nearest'});
  } else {
    setView('session');
    // Auto-open final report
    setTimeout(function() {
      var report = document.querySelector('.artifact-item[data-path="final-report.md"]');
      if (report) report.click();
    }, 500);
  }
  loadArtifacts(name);
}

function resumeSession(name) {
  navigate('/sessions/' + encodeURIComponent(name));
  setView('new');
  document.getElementById('setup-section').style.display = 'none';
  document.getElementById('chat-section').style.display = 'none';
  document.getElementById('log-section').style.display = 'block';
  document.getElementById('log').innerHTML = '';
  addLog('status', 'Resuming session: ' + name);
  currentSessionName = name;

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onopen = function() {
    ws.send(JSON.stringify({
      type: 'start',
      agents: Array.from(selected),
      analyst: document.getElementById('sel-analyst').value,
      supervisor: document.getElementById('sel-supervisor').value,
      reporter: document.getElementById('sel-reporter').value
    }));
    setTimeout(function() { ws.send(JSON.stringify({ type: 'resume', session: name })); }, 100);
  };
  ws.onmessage = handleMsg;
  ws.onclose = function() { addLog('error', 'Connection lost'); };
}

// ── Router ──
function route() {
  var path = location.pathname;

  // / and /sessions — sessions list (home)
  if (path === '/' || path === '/sessions') {
    setView('sessions');
    loadSessions();
    return;
  }

  // /sessions/new
  if (path === '/sessions/new') {
    setView('new');
    // Reset form
    document.getElementById('setup-section').style.display = 'block';
    document.getElementById('chat-section').style.display = 'none';
    document.getElementById('log-section').style.display = 'none';
    document.getElementById('chat-messages').innerHTML = '';
    document.getElementById('log').innerHTML = '';
    document.getElementById('artifacts-sidebar').innerHTML = '';
    currentSessionName = null;
    if (ws) { try { ws.close(); } catch(e){} ws = null; }
    renderAgents();
    renderSelects();
    loadSessions();
    return;
  }

  // /sessions/:name
  var m = path.match(/^\\/sessions\\/(.+)$/);
  if (m) {
    var name = decodeURIComponent(m[1]);
    activeSessionName = name;
    showSession(name);
    return;
  }

  // fallback
  navigate('/', true);
  route();
}

route();
</script>
</body>
</html>`;

// ── Server ──

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    // SPA routes: /, /sessions, /sessions/:name
    if (url.pathname === "/" || url.pathname === "/sessions" || /^\/sessions\/[^/]+$/.test(url.pathname)) {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/sessions") {
      return Response.json(await listSessions());
    }

    // Artifacts list
    const artifactsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
    if (artifactsMatch) {
      const sname = decodeURIComponent(artifactsMatch[1]!);
      return Response.json({
        artifacts: await listSessionArtifacts(sname),
        assignment: await getSessionAssignment(sname),
      });
    }

    // Single artifact
    const artifactMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact\/(.+)$/);
    if (artifactMatch) {
      const name = decodeURIComponent(artifactMatch[1]!);
      const relPath = decodeURIComponent(artifactMatch[2]!);
      if (relPath.includes("..")) return new Response("Forbidden", { status: 403 });
      try {
        const content = await Bun.file(resolve(process.cwd(), "sessions", name, relPath)).text();
        return new Response(content, { headers: { "content-type": "text/markdown" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    // Session meta
    const metaMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/meta$/);
    if (metaMatch) {
      try {
        const content = await Bun.file(resolve(process.cwd(), "sessions", decodeURIComponent(metaMatch[1]!), "meta.json")).text();
        return Response.json(JSON.parse(content));
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    // Report shorthand
    const reportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/report$/);
    if (reportMatch) {
      try {
        const content = await Bun.file(resolve(process.cwd(), "sessions", decodeURIComponent(reportMatch[1]!), "final-report.md")).text();
        return new Response(content, { headers: { "content-type": "text/markdown" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      wsStates.set(ws, newState());
    },
    async message(ws, message) {
      const state = wsStates.get(ws);
      if (!state) return;
      try {
        const data = JSON.parse(String(message));
        switch (data.type) {
          case "start":
            state.config = {
              analyst: data.analyst || "claude",
              supervisor: data.supervisor || "claude",
              reporter: data.reporter || "claude",
              participants: data.agents || [...ALL_AGENTS],
            };
            send(ws, { type: "config-ok" });
            break;
          case "chat":
            await handleAnalystChat(ws, state, data.text);
            break;
          case "run":
            await handleRun(ws, state);
            break;
          case "resume":
            await handleResume(ws, state, data.session);
            break;
          case "continue":
            if (state.continueResolve) {
              state.continueResolve();
              state.continueResolve = null;
            }
            break;
        }
      } catch (err: any) {
        send(ws, { type: "error", text: err.message || String(err) });
      }
    },
    async close(ws) {
      const state = wsStates.get(ws);
      if (state?.analystAgent) {
        try { await state.analystAgent.close(); } catch {}
      }
      wsStates.delete(ws);
    },
  },
});

console.log(`Consilium web UI: http://localhost:${PORT}`);
