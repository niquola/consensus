import { mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { getAgent, ALL_AGENTS, AGENT_LABELS, type AgentType, type AgentLabel } from "./agent";
import { ROUND1_PROMPT, ROUND2_PROMPT, FINAL_REPORT_PROMPT } from "./prompts";

const ROUNDS = 3;

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

/** Shuffle array in place (Fisher-Yates) */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Map of label -> agentType, shuffled each round */
function assignAgents(): Map<AgentLabel, AgentType> {
  const shuffled = shuffle(ALL_AGENTS);
  const map = new Map<AgentLabel, AgentType>();
  AGENT_LABELS.forEach((label, i) => map.set(label, shuffled[i]));
  return map;
}

async function runRound1(baseDir: string, problemPath: string) {
  console.log("\n=== Round 1: Independent solutions ===\n");

  const assignment = assignAgents();
  const problem = await readFile(problemPath);

  // Create dirs and copy problem
  for (const label of AGENT_LABELS) {
    const dir = resolve(baseDir, "r1", label);
    await ensureDir(dir);
    await writeFile(resolve(dir, "problem.md"), problem);
  }

  // Run all 4 agents in parallel
  await Promise.all(
    AGENT_LABELS.map(async (label) => {
      const agentType = assignment.get(label)!;
      const agent = getAgent(agentType);
      const dir = resolve(baseDir, "r1", label);
      console.log(`  Starting ${agent.name} as [${label}]...`);
      const output = await agent.run(dir, ROUND1_PROMPT);
      if (!(await Bun.file(resolve(dir, "solution.md")).exists())) {
        await writeFile(resolve(dir, "solution.md"), output);
      }
      console.log(`  [${label}] (${agent.name}) done.`);
    })
  );

  logAssignment(assignment);
}

async function runRound(baseDir: string, round: number, problemPath: string) {
  console.log(`\n=== Round ${round}: Compare & improve ===\n`);

  const prevRound = round - 1;
  const assignment = assignAgents();
  const problem = await readFile(problemPath);

  // Prepare directories: each agent gets solutions from the other 3
  for (const label of AGENT_LABELS) {
    const dir = resolve(baseDir, `r${round}`, label);
    await ensureDir(dir);
    await writeFile(resolve(dir, "problem.md"), problem);

    // Get other labels, shuffle them for anonymity
    const otherLabels = shuffle(AGENT_LABELS.filter((l) => l !== label));
    for (let i = 0; i < otherLabels.length; i++) {
      await copyFile(
        resolve(baseDir, `r${prevRound}`, otherLabels[i], "solution.md"),
        resolve(dir, `solution-${i + 1}.md`)
      );
    }
  }

  // Run all 4 agents in parallel
  await Promise.all(
    AGENT_LABELS.map(async (label) => {
      const agentType = assignment.get(label)!;
      const agent = getAgent(agentType);
      const dir = resolve(baseDir, `r${round}`, label);
      console.log(`  Starting ${agent.name} as [${label}]...`);
      const output = await agent.run(dir, ROUND2_PROMPT);
      if (!(await Bun.file(resolve(dir, "solution.md")).exists())) {
        await writeFile(resolve(dir, "solution.md"), output);
      }
      console.log(`  [${label}] (${agent.name}) done.`);
    })
  );

  logAssignment(assignment);
}

async function runFinalReport(baseDir: string, problemPath: string) {
  console.log("\n=== Final Report ===\n");

  const reportDir = resolve(baseDir, "final");
  await ensureDir(reportDir);

  await copyFile(problemPath, resolve(reportDir, "problem.md"));

  // Copy all 4 final solutions as solution-a/b/c/d.md
  for (const label of AGENT_LABELS) {
    await copyFile(
      resolve(baseDir, `r${ROUNDS}`, label, "solution.md"),
      resolve(reportDir, `solution-${label}.md`)
    );
  }

  const agent = getAgent("claude");
  console.log(`  Running ${agent.name} for final analysis...`);
  const output = await agent.run(reportDir, FINAL_REPORT_PROMPT);

  const reportPath = resolve(baseDir, "final-report.md");
  if (await Bun.file(resolve(reportDir, "final-report.md")).exists()) {
    await copyFile(resolve(reportDir, "final-report.md"), reportPath);
  } else {
    await writeFile(reportPath, output);
  }

  console.log(`\n  Final report: ${reportPath}`);
}

function logAssignment(assignment: Map<AgentLabel, AgentType>) {
  const pairs = [...assignment.entries()].map(([l, a]) => `${l}=${a}`).join(", ");
  console.log(`  (assignment: ${pairs})`);
}

async function main() {
  const problemArg = process.argv[2];
  if (!problemArg) {
    console.error("Usage: consilium <problem.md>");
    process.exit(1);
  }

  const problemPath = resolve(process.cwd(), problemArg);
  if (!(await Bun.file(problemPath).exists())) {
    console.error(`File not found: ${problemPath}`);
    process.exit(1);
  }

  const sessionName = new Date().toISOString().slice(0, 10) + "-" + Date.now();
  const baseDir = resolve(process.cwd(), "sessions", sessionName);
  await ensureDir(baseDir);

  console.log(`Consilium session: ${baseDir}`);
  console.log(`Problem: ${problemPath}`);
  console.log(`Agents: ${ALL_AGENTS.join(", ")}`);
  console.log(`Rounds: ${ROUNDS}`);

  await runRound1(baseDir, problemPath);

  for (let round = 2; round <= ROUNDS; round++) {
    await runRound(baseDir, round, problemPath);
  }

  await runFinalReport(baseDir, problemPath);

  console.log(`\nDone! See ${baseDir}/final-report.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
