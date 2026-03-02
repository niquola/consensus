import { resolve } from "node:path";

// ── Types ──

export interface SessionPrompts {
  problem: string;
  analyst: string;
  round1: string;
  round2: string;
  round3: string;
  summary: string;
  report: string;
  agents: string;
}

export interface RoundHistory {
  round: number;
  title: string;
  solutions: Map<string, string>;
}

// ── Parse / Serialize prompts.md format ──

const SECTIONS = ["problem", "analyst", "round1", "round2", "round3", "summary", "report", "agents"] as const;

export function parsePrompts(text: string): SessionPrompts {
  const result: Record<string, string> = {};
  const parts = text.split(/^--- (\w+) ---$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i]!.trim();
    const val = parts[i + 1]?.trim() || "";
    result[key] = val;
  }
  return result as unknown as SessionPrompts;
}

export function serializePrompts(p: SessionPrompts): string {
  return SECTIONS.map(s => `--- ${s} ---\n${p[s]}`).join("\n\n");
}

// ── Load defaults from src/prompts.md ──

const defaultsMd = await Bun.file(resolve(import.meta.dir, "prompts.md")).text();
const DEFAULTS = parsePrompts(defaultsMd);

export function getDefaults(): SessionPrompts {
  return { ...DEFAULTS };
}

// ── Language detection ──

export const DETECT_LANGUAGE_PROMPT = `Detect the language of the following text. Reply with ONLY the language name in English (e.g. "Russian", "English", "Chinese", "Japanese", "Spanish"). Nothing else.

Text:
`;

function langSuffix(lang?: string): string {
  if (!lang || lang.toLowerCase() === "english") return "";
  return `\n\nIMPORTANT: Respond entirely in ${lang}.`;
}

// ── Legacy prompts (for CLI/file-based mode) ──

export const ANALYST_SYSTEM = DEFAULTS.analyst;

export const ROUND1_PROMPT = `You are an expert problem solver participating in an anonymous peer review process.

Read the problem described in problem.md in your working directory.
Think deeply about it. You may experiment — write code, run tests, explore approaches.
Write your solution into solution.md in your working directory.

Your solution.md should include:
- Your proposed approach
- Key reasoning and trade-offs considered
- Concrete implementation details or code if applicable`;

export const ROUND2_PROMPT = `You are an expert problem solver participating in an anonymous peer review process.

In your working directory you have:
- problem.md — the original problem
- solution-1.md, solution-2.md, solution-3.md — three proposed solutions from other anonymous participants

Read all files. Compare the three solutions:
- What are the strengths and weaknesses of each?
- Which ideas are best and why?
- Can you combine the best parts?

Write your improved solution into solution.md. Explain your reasoning.`;

export const ROUND_SUMMARY_PROMPT = `You are summarizing a round of multi-agent deliberation.

In your working directory there are subdirectories a/, b/, c/, d/ — each containing a solution.md from an anonymous participant.

Read all four solution.md files and write a concise 2-paragraph summary:

Paragraph 1: What approaches were proposed? What are the key ideas across all four solutions?
Paragraph 2: Where do they agree? Where do they diverge? Any surprising or creative ideas?

Output ONLY the two paragraphs, no headings, no bullet lists. Keep it under 150 words total.`;

export const FINAL_REPORT_PROMPT = `You are an expert analyst. Your job is to produce a final report on a problem-solving consilium.

In your working directory you have:
- problem.md — the original problem
- solution-a.md, solution-b.md, solution-c.md, solution-d.md — final solutions from four anonymous participants after 3 rounds of deliberation

Analyze all four final solutions and write final-report.md that includes:

## Problem
Briefly restate the problem.

## Consensus
What the participants agree on. If they converged on similar solutions, describe the common approach.

## Disagreements
Where opinions differ, if at all. Explain all sides.

## Recommendation
Your recommended course of action, synthesizing the best of all solutions.

## Appendix
Brief comparison table of all four solutions — key differences and similarities.`;

// ── Chat helpers ──

export function buildAnalystChatPrompt(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  lang?: string,
  template?: string,
): string {
  let conv = (template || DEFAULTS.analyst) + langSuffix(lang) + "\n\n";
  for (const msg of history) {
    const label = msg.role === "user" ? "Human" : "Assistant";
    conv += `${label}: ${msg.text}\n\n`;
  }
  return conv;
}

// ── Template-based builders ──

export function buildRound1Prompt(problem: string, lang?: string, template?: string): string {
  const t = template || DEFAULTS.round1;
  return t.replace("{problem}", problem) + langSuffix(lang);
}

export function buildRound2Prompt(problem: string, peerSolutions: string[], lang?: string, template?: string): string {
  const blocks = peerSolutions
    .map((s, i) => `### Solution ${i + 1}\n\n${s}`)
    .join("\n\n---\n\n");
  const t = template || DEFAULTS.round2;
  return t.replace("{problem}", problem).replace("{peer_solutions}", blocks) + langSuffix(lang);
}

export function buildRound3Prompt(
  problem: string,
  ownSolution: string,
  peerSolutions: string[],
  lang?: string,
  template?: string,
): string {
  const blocks = peerSolutions
    .map((s, i) => `### Peer Solution ${i + 1}\n\n${s}`)
    .join("\n\n---\n\n");
  const t = template || DEFAULTS.round3;
  return t
    .replace("{problem}", problem)
    .replace("{own_solution}", ownSolution)
    .replace("{peer_solutions}", blocks)
    + langSuffix(lang);
}

export function buildRoundSummaryPrompt(solutions: Map<string, string>, lang?: string, template?: string): string {
  const blocks = [...solutions.entries()]
    .map(([label, text]) => `### Participant ${label}\n\n${text}`)
    .join("\n\n---\n\n");
  const t = template || DEFAULTS.summary;
  return t.replace("{solutions}", blocks) + langSuffix(lang);
}

export function buildFinalReportPrompt(
  problem: string,
  rounds: RoundHistory[],
  lang?: string,
  template?: string,
): string {
  const roundBlocks = rounds.map((r) => {
    const sols = [...r.solutions.entries()]
      .map(([label, text]) => `### Agent ${label}\n\n${text}`)
      .join("\n\n---\n\n");
    return `# Round ${r.round}: ${r.title}\n\n${sols}`;
  }).join("\n\n===\n\n");
  const t = template || DEFAULTS.report;
  return t.replace("{problem}", problem).replace("{rounds}", roundBlocks) + langSuffix(lang);
}
