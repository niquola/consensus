# consilium

Multi-agent deliberation tool. Multiple AI agents independently solve the same problem, then review each other's solutions across 3 rounds, converging toward consensus.

## How it works

```
Problem → Round 1: Solve → Round 2: Improve → Round 3: Defend → Final Report
            (independent)    (cross-review)     (defend/yield)    (synthesis)
```

1. **Analyst chat** — You describe your problem in conversation with an AI analyst that helps structure it
2. **Round 1: Solve** — Each agent independently proposes a solution
3. **Round 2: Improve** — Agents read each other's solutions (anonymized, shuffled) and write improved versions, attributing adopted ideas
4. **Round 3: Defend** — Agents defend their approach or yield to better ideas from peers, producing final solutions with full idea attribution
5. **Final Report** — A reporter agent analyzes all rounds and produces a consensus report with idea provenance, agreements, disagreements, and recommendations

Agents are assigned random labels (a, b, c, d, e) so they don't know who proposed what — only the ideas matter.

## Agents

Uses [ACP](https://github.com/anthropics/agent-client-protocol) (Agent Client Protocol) to run agents as long-lived subprocesses:

- **claude** — Claude Code CLI
- **codex** — OpenAI Codex CLI
- **gemini** — Google Gemini CLI
- **kimi** — Kimi (Moonshot) CLI
- **opencode** — OpenCode with GLM-5

Set `CONSILIUM_LEGACY=1` to fall back to one-shot CLI invocations.

## Install

```bash
bun install
```

## Usage

### Web UI

```bash
bun src/web.ts
# → http://localhost:3000
```

Create a session, pick which agents participate, customize prompt templates, chat with the analyst to define your problem, review the generated problem statement, then run. Progress and artifacts appear in the sidebar. You can run multiple sessions in parallel and switch between them.

#### Session flow

1. **New Session** — pick agents, roles (analyst/supervisor/reporter), edit prompt templates (tabbed UI)
2. **Chat** — conversation with the AI analyst to define your problem
3. **Review** — edit the session name and problem statement before launching agents
4. **Run** — all 3 rounds execute automatically, progress shown as spinners in the sidebar
5. **Done** — browse artifacts, click to view rendered markdown

### CLI

```bash
# Interactive — chat with analyst, then /run
bun src/index.ts

# One-shot prompt
bun src/index.ts "design a key-value store in TypeScript"

# From a problem file
bun src/index.ts problem.md

# Pick agents
bun src/index.ts --agents=claude,gemini,kimi "your problem"
```

## Output

Sessions are saved to `sessions/<date>-<name>/`:

```
sessions/2026-03-02-kv-store/
  problem.md              # structured problem
  prompts.md              # all prompt templates used (editable defaults from src/prompts.md)
  assignment.json         # agent label → model mapping
  meta.json               # timing, config
  r1/a/solution.md        # round 1 solutions
  r1/b/solution.md
  r1/summary.md           # round summary
  r2/...                  # round 2
  r3/...                  # round 3
  final-report.md         # consensus report
```

## Customizing prompts

Default prompt templates live in `src/prompts.md` with `--- section ---` separators. Edit this file to change defaults globally. Per-session overrides are available in the New Session form (tabbed prompt editor). Each session saves its prompts to `prompts.md` in the session directory.

Placeholders in templates: `{problem}`, `{peer_solutions}`, `{own_solution}`, `{solutions}`, `{rounds}`.
