import { $ } from "bun";

export type AgentType = "claude" | "codex" | "gemini" | "kimi";

export interface Agent {
  name: AgentType;
  run(workDir: string, prompt: string): Promise<string>;
}

/** Clean env: remove vars that prevent nesting */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k === "CLAUDE_CODE") continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

const LOCAL_BIN = `${process.env.HOME}/.local/bin`;

const claude: Agent = {
  name: "claude",
  async run(workDir, prompt) {
    const result =
      await $`${LOCAL_BIN}/claude -p ${prompt} --dangerously-skip-permissions`
        .cwd(workDir)
        .env(cleanEnv())
        .text();
    return result.trim();
  },
};

const codex: Agent = {
  name: "codex",
  async run(workDir, prompt) {
    const result =
      await $`codex exec ${prompt} -C ${workDir} --dangerously-bypass-approvals-and-sandbox`
        .cwd(workDir)
        .env(cleanEnv())
        .text();
    return result.trim();
  },
};

const gemini: Agent = {
  name: "gemini",
  async run(workDir, prompt) {
    const result =
      await $`gemini -p ${prompt} --yolo`
        .cwd(workDir)
        .env(cleanEnv())
        .text();
    return result.trim();
  },
};

const kimi: Agent = {
  name: "kimi",
  async run(workDir, prompt) {
    const result =
      await $`echo ${prompt} | ${LOCAL_BIN}/kimi --print --final-message-only -w ${workDir}`
        .cwd(workDir)
        .env(cleanEnv())
        .text();
    return result.trim();
  },
};

const agents: Record<AgentType, Agent> = { claude, codex, gemini, kimi };

export const ALL_AGENTS: AgentType[] = ["claude", "codex", "gemini", "kimi"];
export const AGENT_LABELS = ["a", "b", "c", "d"] as const;
export type AgentLabel = (typeof AGENT_LABELS)[number];

export function getAgent(name: AgentType): Agent {
  const agent = agents[name];
  if (!agent) throw new Error(`Unknown agent: ${name}`);
  return agent;
}

export function getAgents(names: AgentType[]): Agent[] {
  return names.map(getAgent);
}
