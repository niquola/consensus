import { mkdir } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { createInterface } from "node:readline";
import { createAgent, ALL_AGENTS, AGENT_LABELS, type AgentType, type AgentLabel, type Agent } from "./agent";

/** Parse --agents=claude,gemini,kimi from argv, return remaining args */
function parseArgs(argv: string[]): { agents: AgentType[]; rest: string } {
  const agentsFlag = argv.find(a => a.startsWith("--agents="));
  if (agentsFlag) {
    const names = agentsFlag.split("=")[1]!.split(",") as AgentType[];
    const rest = argv.filter(a => !a.startsWith("--agents=")).join(" ").trim();
    return { agents: names, rest };
  }
  return { agents: ALL_AGENTS, rest: argv.join(" ").trim() };
}
import {
  ANALYST_SYSTEM,
  buildRound1Prompt,
  buildRound2Prompt,
  buildRoundSummaryPrompt,
  buildFinalReportPrompt,
  type RoundHistory,
} from "./prompts";

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
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
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

function logAssignment(assignment: Map<AgentLabel, AgentType>) {
  const pairs = [...assignment.entries()].map(([l, a]) => `${l}=${a}`).join(", ");
  console.log(`  (${pairs})`);
}

function nameFromFile(filePath: string): string {
  return basename(filePath, ".md").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function elapsed(startMs: number): string {
  const sec = Math.round((Date.now() - startMs) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

// ── Interactive problem discussion ──

async function interactiveMode(): Promise<{ name: string; problem: string }> {
  console.log("\n  Consensus — multi-agent deliberation\n");
  console.log("  Describe your problem. I'll help you structure it.");
  console.log("  Type /run when ready to start the consensus.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, res));

  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  const analyst = createAgent("claude", process.cwd());

  try {
    while (true) {
      const userInput = await ask(`${CYAN}you>${RESET} `);

      if (userInput.trim() === "/run") {
        const finalPrompt = buildConversation(history) +
          "\n\nThe user is ready. Output the final structured problem now using the ---NAME--- and ---PROBLEM--- format.";
        const output = await analyst.prompt(finalPrompt);
        rl.close();
        return parseAnalystOutput(output);
      }

      if (userInput.trim() === "/quit" || userInput.trim() === "/exit") {
        rl.close();
        process.exit(0);
      }

      history.push({ role: "user", text: userInput });

      const conversationPrompt = buildConversation(history);
      const response = await analyst.prompt(conversationPrompt);

      history.push({ role: "assistant", text: response });
      console.log(`\n${YELLOW}analyst>${RESET} ${response}\n`);
    }
  } finally {
    await analyst.close();
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

async function showRoundSummary(solutions: Map<string, string>, round: number) {
  const summarizer = createAgent("claude", process.cwd());
  console.log(`\n${DIM}  Summarizing round ${round}...${RESET}`);
  try {
    const prompt = buildRoundSummaryPrompt(solutions);
    const summary = await summarizer.prompt(prompt);
    console.log(`\n${BOLD}  ── Round ${round} summary ──${RESET}\n`);
    for (const line of summary.split("\n")) {
      console.log(`  ${line}`);
    }
    console.log();
  } finally {
    await summarizer.close();
  }
}

// ── Consensus rounds ──

async function runRound1(
  baseDir: string,
  problemContent: string,
  agents: Map<AgentLabel, Agent>,
  assignment: Map<AgentLabel, AgentType>,
) {
  console.log(`\n${BOLD}=== Round 1: Independent solutions ===${RESET}\n`);
  logAssignment(assignment);
  const roundStart = Date.now();

  const labels = [...agents.keys()];
  console.log(`  ${DIM}${labels.length} agents working in parallel...${RESET}\n`);

  const solutions = new Map<string, string>();

  await Promise.all(
    labels.map(async (label) => {
      const agent = agents.get(label)!;
      const dir = resolve(baseDir, "r1", label);
      await ensureDir(dir);

      const start = Date.now();
      const prompt = buildRound1Prompt(problemContent);
      const output = await agent.prompt(prompt);

      await writeFile(resolve(dir, "solution.md"), output);
      solutions.set(label, output);
      const size = Math.round(output.length / 1024);
      console.log(`  ${GREEN}✓${RESET} ${agent.name} finished ${DIM}(${elapsed(start)}, ${size}kb)${RESET}`);
    })
  );

  console.log(`\n  ${DIM}Round 1 total: ${elapsed(roundStart)}${RESET}`);
  await showRoundSummary(solutions, 1);

  return solutions;
}

async function runRound(
  baseDir: string,
  round: number,
  problemContent: string,
  agents: Map<AgentLabel, Agent>,
  assignment: Map<AgentLabel, AgentType>,
  prevSolutions: Map<string, string>,
) {
  console.log(`${BOLD}=== Round ${round}: Compare & improve ===${RESET}\n`);
  logAssignment(assignment);
  const roundStart = Date.now();

  const labels = [...agents.keys()];
  console.log(`  ${DIM}${labels.length} agents reviewing & improving...${RESET}\n`);

  const solutions = new Map<string, string>();

  await Promise.all(
    labels.map(async (label) => {
      const agent = agents.get(label)!;
      const dir = resolve(baseDir, `r${round}`, label);
      await ensureDir(dir);

      // Gather other agents' solutions (shuffled, anonymous)
      const otherLabels = shuffle(labels.filter((l) => l !== label));
      const peerSolutions = otherLabels.map((l) => prevSolutions.get(l)!);

      const start = Date.now();
      const prompt = buildRound2Prompt(problemContent, peerSolutions);
      const output = await agent.prompt(prompt);

      await writeFile(resolve(dir, "solution.md"), output);
      solutions.set(label, output);
      const size = Math.round(output.length / 1024);
      console.log(`  ${GREEN}✓${RESET} ${agent.name} finished ${DIM}(${elapsed(start)}, ${size}kb)${RESET}`);
    })
  );

  console.log(`\n  ${DIM}Round ${round} total: ${elapsed(roundStart)}${RESET}`);
  await showRoundSummary(solutions, round);

  return solutions;
}

async function runFinalReport(baseDir: string, problemContent: string, solutions: Map<string, string>) {
  console.log(`${BOLD}=== Final Report ===${RESET}\n`);

  // Write final solutions to disk for human inspection
  const reportDir = resolve(baseDir, "final");
  await ensureDir(reportDir);
  await writeFile(resolve(reportDir, "problem.md"), problemContent);
  for (const [label, text] of solutions) {
    await writeFile(resolve(reportDir, `solution-${label}.md`), text);
  }

  const analyst = createAgent("claude", process.cwd());
  const start = Date.now();
  console.log(`  ${DIM}Analyzing consensus...${RESET}\n`);

  try {
    const rounds: RoundHistory[] = [{ round: 3, title: "Final", solutions }];
    const prompt = buildFinalReportPrompt(problemContent, rounds);
    const report = await analyst.prompt(prompt);

    const reportPath = resolve(baseDir, "final-report.md");
    await writeFile(reportPath, report);
    await writeFile(resolve(reportDir, "final-report.md"), report);

    console.log(`  ${GREEN}✓${RESET} Final report ready ${DIM}(${elapsed(start)})${RESET}`);
    console.log(`  ${reportPath}`);
  } finally {
    await analyst.close();
  }
}

// ── Run consensus pipeline ──

async function runConsensus(problemContent: string, sessionName: string, agentTypes: AgentType[]) {
  const baseDir = resolve(process.cwd(), "sessions", sessionName);
  await ensureDir(baseDir);
  await writeFile(resolve(baseDir, "problem.md"), problemContent);

  console.log(`\nConsensus session: ${baseDir}`);
  console.log(`Agents: ${agentTypes.join(", ")}`);
  console.log(`Rounds: ${ROUNDS}`);
  console.log(`Mode: ${process.env.CONSILIUM_LEGACY === "1" ? "legacy (CLI)" : "ACP"}`);

  // Create agents — one per type, reused across rounds
  const assignment = assignAgents(agentTypes);
  const agents = new Map<AgentLabel, Agent>();

  console.log(`\n  ${DIM}Starting agents...${RESET}`);
  for (const [label, agentType] of assignment) {
    agents.set(label, createAgent(agentType, baseDir));
  }

  try {
    // Round 1: independent solutions
    let solutions = await runRound1(baseDir, problemContent, agents, assignment);

    // Rounds 2..N: compare & improve
    for (let round = 2; round <= ROUNDS; round++) {
      solutions = await runRound(baseDir, round, problemContent, agents, assignment, solutions);
    }

    // Final report
    await runFinalReport(baseDir, problemContent, solutions);
  } finally {
    // Always clean up agent processes
    await Promise.all([...agents.values()].map((a) => a.close()));
  }

  console.log(`\nDone! See ${baseDir}/final-report.md`);
}

// ── Main ──

async function main() {
  const { agents: agentTypes, rest: input } = parseArgs(process.argv.slice(2));
  const date = new Date().toISOString().slice(0, 10);

  if (!input) {
    // Interactive mode: discuss problem, then /run
    const { name, problem } = await interactiveMode();
    console.log(`\n  Problem: ${name}`);
    console.log(`  Starting consensus...\n`);
    await runConsensus(problem, `${date}-${name}`, agentTypes);
    return;
  }

  const isFile = input.endsWith(".md") && await Bun.file(resolve(process.cwd(), input)).exists();

  if (isFile) {
    // File mode: use problem file directly
    const filePath = resolve(process.cwd(), input);
    const problemContent = await readFile(filePath);
    console.log(`Using problem file: ${filePath}`);
    await runConsensus(problemContent, `${date}-${nameFromFile(input)}`, agentTypes);
  } else {
    // One-shot prompt: analyst structures, then run
    console.log("\n=== Problem Analysis ===\n");
    const analyst = createAgent("claude", process.cwd());
    try {
      console.log(`  Analyst structuring the problem...`);
      const promptText = `${ANALYST_SYSTEM}\n\nHuman: ${input}\n\nOutput the structured problem now using the ---NAME--- and ---PROBLEM--- format.`;
      const output = await analyst.prompt(promptText);
      const { name, problem } = parseAnalystOutput(output);
      console.log(`  Problem: ${name}\n`);
      await runConsensus(problem, `${date}-${name}`, agentTypes);
    } finally {
      await analyst.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
