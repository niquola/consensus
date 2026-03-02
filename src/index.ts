import { mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { createInterface } from "node:readline";
import { getAgent, ALL_AGENTS, AGENT_LABELS, type AgentType, type AgentLabel } from "./agent";
import { ANALYST_SYSTEM, ROUND1_PROMPT, ROUND2_PROMPT, ROUND_SUMMARY_PROMPT, FINAL_REPORT_PROMPT } from "./prompts";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

const ROUNDS = 3;

// ── Helpers ──

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

async function writeFile(path: string, content: string) {
  await ensureDir(dirname(path));
  await Bun.write(path, content);
}

async function readFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function assignAgents(): Map<AgentLabel, AgentType> {
  const shuffled = shuffle(ALL_AGENTS);
  const map = new Map<AgentLabel, AgentType>();
  AGENT_LABELS.forEach((label, i) => map.set(label, shuffled[i]));
  return map;
}

function logAssignment(assignment: Map<AgentLabel, AgentType>) {
  const pairs = [...assignment.entries()].map(([l, a]) => `${l}=${a}`).join(", ");
  console.log(`  (${pairs})`);
}

function nameFromFile(filePath: string): string {
  return basename(filePath, ".md").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

// ── Interactive problem discussion ──

async function interactiveMode(): Promise<{ name: string; problem: string }> {
  console.log("\n  Consensus — multi-agent deliberation\n");
  console.log("  Describe your problem. I'll help you structure it.");
  console.log("  Type /run when ready to start the consensus.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, res));

  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  const agent = getAgent("claude");

  while (true) {
    const userInput = await prompt("\x1b[36myou>\x1b[0m ");

    if (userInput.trim() === "/run") {
      // Ask analyst to produce the final structured output
      const finalPrompt = buildConversation(history) +
        "\n\nThe user is ready. Output the final structured problem now using the ---NAME--- and ---PROBLEM--- format.";
      const output = await agent.run(process.cwd(), finalPrompt);
      rl.close();
      return parseAnalystOutput(output);
    }

    if (userInput.trim() === "/quit" || userInput.trim() === "/exit") {
      rl.close();
      process.exit(0);
    }

    history.push({ role: "user", text: userInput });

    const conversationPrompt = buildConversation(history);
    const response = await agent.run(process.cwd(), conversationPrompt);

    history.push({ role: "assistant", text: response });
    console.log(`\n\x1b[33manalyst>\x1b[0m ${response}\n`);
  }
}

function buildConversation(history: Array<{ role: string; text: string }>): string {
  let conv = ANALYST_SYSTEM + "\n\n";
  for (const msg of history) {
    const label = msg.role === "user" ? "Human" : "Assistant";
    conv += `${label}: ${msg.text}\n\n`;
  }
  return conv;
}

function parseAnalystOutput(output: string): { name: string; problem: string } {
  const nameMatch = output.match(/---NAME---\s*\n([^\n]+)/);
  const problemMatch = output.match(/---PROBLEM---\s*\n([\s\S]+)$/);
  const name = nameMatch?.[1]?.trim() || "unknown-problem";
  const problem = problemMatch?.[1]?.trim() || output;
  return { name, problem };
}

// ── Round summaries ──

async function showRoundSummary(baseDir: string, round: number) {
  const roundDir = resolve(baseDir, `r${round}`);
  const agent = getAgent("claude");
  console.log(`\n${DIM}  Summarizing round ${round}...${RESET}`);
  const summary = await agent.run(roundDir, ROUND_SUMMARY_PROMPT);
  console.log(`\n${BOLD}  ── Round ${round} summary ──${RESET}\n`);
  // Indent each line of the summary
  for (const line of summary.split("\n")) {
    console.log(`  ${line}`);
  }
  console.log();
}

function elapsed(startMs: number): string {
  const sec = Math.round((Date.now() - startMs) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

// ── Consensus rounds ──

async function runRound1(baseDir: string, problemPath: string) {
  console.log(`\n${BOLD}=== Round 1: Independent solutions ===${RESET}\n`);

  const assignment = assignAgents();
  const problem = await readFile(problemPath);
  const roundStart = Date.now();

  for (const label of AGENT_LABELS) {
    const dir = resolve(baseDir, "r1", label);
    await ensureDir(dir);
    await writeFile(resolve(dir, "problem.md"), problem);
  }

  console.log(`  ${DIM}4 agents working in parallel...${RESET}\n`);

  await Promise.all(
    AGENT_LABELS.map(async (label) => {
      const agentType = assignment.get(label)!;
      const agent = getAgent(agentType);
      const dir = resolve(baseDir, "r1", label);
      const start = Date.now();
      const output = await agent.run(dir, ROUND1_PROMPT);
      if (!(await Bun.file(resolve(dir, "solution.md")).exists())) {
        await writeFile(resolve(dir, "solution.md"), output);
      }
      const size = Math.round(output.length / 1024);
      console.log(`  ${GREEN}✓${RESET} ${agent.name} finished ${DIM}(${elapsed(start)}, ${size}kb)${RESET}`);
    })
  );

  console.log(`\n  ${DIM}Round 1 total: ${elapsed(roundStart)}${RESET}`);
  await showRoundSummary(baseDir, 1);
}

async function runRound(baseDir: string, round: number, problemPath: string) {
  console.log(`${BOLD}=== Round ${round}: Compare & improve ===${RESET}\n`);

  const prevRound = round - 1;
  const assignment = assignAgents();
  const problem = await readFile(problemPath);
  const roundStart = Date.now();

  for (const label of AGENT_LABELS) {
    const dir = resolve(baseDir, `r${round}`, label);
    await ensureDir(dir);
    await writeFile(resolve(dir, "problem.md"), problem);

    const otherLabels = shuffle(AGENT_LABELS.filter((l) => l !== label));
    for (let i = 0; i < otherLabels.length; i++) {
      await copyFile(
        resolve(baseDir, `r${prevRound}`, otherLabels[i], "solution.md"),
        resolve(dir, `solution-${i + 1}.md`)
      );
    }
  }

  console.log(`  ${DIM}4 agents reviewing & improving...${RESET}\n`);

  await Promise.all(
    AGENT_LABELS.map(async (label) => {
      const agentType = assignment.get(label)!;
      const agent = getAgent(agentType);
      const dir = resolve(baseDir, `r${round}`, label);
      const start = Date.now();
      const output = await agent.run(dir, ROUND2_PROMPT);
      if (!(await Bun.file(resolve(dir, "solution.md")).exists())) {
        await writeFile(resolve(dir, "solution.md"), output);
      }
      const size = Math.round(output.length / 1024);
      console.log(`  ${GREEN}✓${RESET} ${agent.name} finished ${DIM}(${elapsed(start)}, ${size}kb)${RESET}`);
    })
  );

  console.log(`\n  ${DIM}Round ${round} total: ${elapsed(roundStart)}${RESET}`);
  await showRoundSummary(baseDir, round);
}

async function runFinalReport(baseDir: string, problemPath: string) {
  console.log(`${BOLD}=== Final Report ===${RESET}\n`);

  const reportDir = resolve(baseDir, "final");
  await ensureDir(reportDir);

  await copyFile(problemPath, resolve(reportDir, "problem.md"));

  for (const label of AGENT_LABELS) {
    await copyFile(
      resolve(baseDir, `r${ROUNDS}`, label, "solution.md"),
      resolve(reportDir, `solution-${label}.md`)
    );
  }

  const agent = getAgent("claude");
  const start = Date.now();
  console.log(`  ${DIM}Analyzing consensus...${RESET}\n`);
  const output = await agent.run(reportDir, FINAL_REPORT_PROMPT);

  const reportPath = resolve(baseDir, "final-report.md");
  if (await Bun.file(resolve(reportDir, "final-report.md")).exists()) {
    await copyFile(resolve(reportDir, "final-report.md"), reportPath);
  } else {
    await writeFile(reportPath, output);
  }

  console.log(`  ${GREEN}✓${RESET} Final report ready ${DIM}(${elapsed(start)})${RESET}`);
  console.log(`  ${reportPath}`);
}

// ── Run consensus pipeline ──

async function runConsensus(problemContent: string, sessionName: string) {
  const baseDir = resolve(process.cwd(), "sessions", sessionName);
  await ensureDir(baseDir);

  const problemPath = resolve(baseDir, "problem.md");
  await writeFile(problemPath, problemContent);

  console.log(`\nConsensus session: ${baseDir}`);
  console.log(`Agents: ${ALL_AGENTS.join(", ")}`);
  console.log(`Rounds: ${ROUNDS}`);

  await runRound1(baseDir, problemPath);

  for (let round = 2; round <= ROUNDS; round++) {
    await runRound(baseDir, round, problemPath);
  }

  await runFinalReport(baseDir, problemPath);

  console.log(`\nDone! See ${baseDir}/final-report.md`);
}

// ── Main ──

async function main() {
  const input = process.argv.slice(2).join(" ").trim();
  const date = new Date().toISOString().slice(0, 10);

  if (!input) {
    // Interactive mode: discuss problem, then /run
    const { name, problem } = await interactiveMode();
    console.log(`\n  Problem: ${name}`);
    console.log(`  Starting consensus...\n`);
    await runConsensus(problem, `${date}-${name}`);
    return;
  }

  const isFile = input.endsWith(".md") && await Bun.file(resolve(process.cwd(), input)).exists();

  if (isFile) {
    // File mode: use problem file directly
    const filePath = resolve(process.cwd(), input);
    const problemContent = await readFile(filePath);
    console.log(`Using problem file: ${filePath}`);
    await runConsensus(problemContent, `${date}-${nameFromFile(input)}`);
  } else {
    // One-shot prompt: analyst structures, then run
    console.log("\n=== Problem Analysis ===\n");
    const agent = getAgent("claude");
    console.log(`  Analyst structuring the problem...`);
    const prompt = `${ANALYST_SYSTEM}\n\nHuman: ${input}\n\nOutput the structured problem now using the ---NAME--- and ---PROBLEM--- format.`;
    const output = await agent.run(process.cwd(), prompt);
    const { name, problem } = parseAnalystOutput(output);
    console.log(`  Problem: ${name}\n`);
    await runConsensus(problem, `${date}-${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
