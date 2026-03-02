export const ANALYST_SYSTEM = `You are a problem analyst helping a human formulate a problem statement for a multi-agent deliberation (consensus process).

Your job is to have a conversation with the human to understand what they want to solve. Ask clarifying questions to understand the problem and what the human cares about.

Keep responses concise — 2-3 sentences. Be conversational, not formal.

When the human says /run (or you feel the problem is clear enough), output the result in this EXACT format:

---NAME---
<kebab-case-name-2-4-words>
---PROBLEM---
## Problem
<What needs to be solved — high level, 2-4 sentences>

## Wishes
<Bullet list of things the human mentioned they care about, want, or prefer — in their own words as much as possible. Only things they actually said, not your additions.>`;

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

// ── Language instruction ──

export const DETECT_LANGUAGE_PROMPT = `Detect the language of the following text. Reply with ONLY the language name in English (e.g. "Russian", "English", "Chinese", "Japanese", "Spanish"). Nothing else.

Text:
`;

function langSuffix(lang?: string): string {
  if (!lang || lang.toLowerCase() === "english") return "";
  return `\n\nIMPORTANT: Respond entirely in ${lang}.`;
}

// ── Chat helpers ──

export function buildAnalystChatPrompt(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  lang?: string,
): string {
  let conv = ANALYST_SYSTEM + langSuffix(lang) + "\n\n";
  for (const msg of history) {
    const label = msg.role === "user" ? "Human" : "Assistant";
    conv += `${label}: ${msg.text}\n\n`;
  }
  return conv;
}

// ── Inline content builders (for ACP mode) ──

export function buildRound1Prompt(problem: string, lang?: string): string {
  return `You are an expert problem solver participating in an anonymous peer review process.

## Problem

${problem}

Think deeply about this problem. Propose your solution.

Your response MUST include:
- Your proposed approach with concrete implementation details
- Key reasoning and trade-offs considered

IMPORTANT — At the end of your response, include a section:

## Key Ideas
List each distinct idea or design decision you are proposing as a bullet, e.g.:
- **[IDEA: short-name]** — one-sentence description of the idea and why you chose it${langSuffix(lang)}`;
}

export function buildRound2Prompt(problem: string, peerSolutions: string[], lang?: string): string {
  const blocks = peerSolutions
    .map((s, i) => `### Solution ${i + 1}\n\n${s}`)
    .join("\n\n---\n\n");

  return `You are an expert problem solver participating in an anonymous peer review process.

## Problem

${problem}

## Other Participants' Solutions

${blocks}

Compare the solutions above. Write your improved solution combining the best ideas.

IMPORTANT — At the end of your response, include a section:

## Adopted Ideas
For each idea you incorporated, state where it came from:
- **[FROM Solution N: short-name]** — what you adopted and why it's good
- **[ORIGINAL: short-name]** — ideas that are your own new contribution
- **[REJECTED: short-name from Solution N]** — ideas you considered but rejected, and why${langSuffix(lang)}`;
}

export function buildRound3Prompt(
  problem: string,
  ownSolution: string,
  peerSolutions: string[],
  lang?: string,
): string {
  const blocks = peerSolutions
    .map((s, i) => `### Peer Solution ${i + 1}\n\n${s}`)
    .join("\n\n---\n\n");

  return `You are an expert problem solver in the FINAL round of an anonymous peer review.

## Problem

${problem}

## Your Previous Solution

${ownSolution}

## Updated Peer Solutions

${blocks}

This is the DEFEND round. Your task:
1. Read the updated peer solutions carefully
2. Identify where your approach differs from others
3. For each disagreement: DEFEND your choice or YIELD to a better one
4. Produce your FINAL solution incorporating only ideas you can defend

Your response MUST include your final solution, followed by these sections:

## Key Disagreements
For each point of contention:
- **[DEFEND: short-name]** — why your approach is better (evidence, trade-offs)
- **[YIELD to Peer N: short-name]** — why their approach is better and you adopt it

## Final Idea Attribution
Trace each key idea in your final solution to its origin:
- **[OWN: short-name]** — your original idea, kept through all rounds
- **[ADOPTED R2: short-name from Solution N]** — adopted in the Improve round
- **[ADOPTED R3: short-name from Peer N]** — adopted in this Defend round${langSuffix(lang)}`;
}

export function buildRoundSummaryPrompt(solutions: Map<string, string>, lang?: string): string {
  const blocks = [...solutions.entries()]
    .map(([label, text]) => `### Participant ${label}\n\n${text}`)
    .join("\n\n---\n\n");

  return `You are summarizing a round of multi-agent deliberation.

Below are four solutions from anonymous participants:

${blocks}

Write a concise 2-paragraph summary:

Paragraph 1: What approaches were proposed? What are the key ideas across all four solutions?
Paragraph 2: Where do they agree? Where do they diverge? Any surprising or creative ideas?

Output ONLY the two paragraphs, no headings, no bullet lists. Keep it under 150 words total.${langSuffix(lang)}`;
}

export interface RoundHistory {
  round: number;
  title: string;
  solutions: Map<string, string>;
}

export function buildFinalReportPrompt(
  problem: string,
  rounds: RoundHistory[],
  lang?: string,
): string {
  const roundBlocks = rounds.map((r) => {
    const sols = [...r.solutions.entries()]
      .map(([label, text]) => `### Agent ${label}\n\n${text}`)
      .join("\n\n---\n\n");
    return `# Round ${r.round}: ${r.title}\n\n${sols}`;
  }).join("\n\n===\n\n");

  return `You are an expert analyst. Your job is to produce a final report on a problem-solving consilium.

## Problem

${problem}

## Full Deliberation History

${roundBlocks}

Analyze the FULL deliberation across all rounds and produce a report:

## Problem
Briefly restate the problem.

## Idea Provenance
Trace the origin and evolution of each key idea through the rounds:
- Who first proposed it (Round 1)?
- Who adopted it in Round 2 (Improve)? Who rejected it?
- Who defended or yielded on it in Round 3 (Defend)?
Use a table: | Idea | Proposed by | Adopted by | Defended by | Final status |

## Consensus
What the participants agree on after 3 rounds. Describe the common approach they converged on.

## Disagreements
Where opinions still differ after deliberation. Explain each side's reasoning.

## Recommendation
Your recommended course of action, synthesizing the best ideas from all agents.

## Agent Contributions
Brief summary of each agent's unique contributions — what did they bring to the table that others didn't?

## Appendix
Comparison table of final solutions — key differences and similarities.${langSuffix(lang)}`;
}
