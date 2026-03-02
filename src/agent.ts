import { $ } from "bun";
import { AcpAgentProcess, ACP_CONFIGS } from "./acp";

export type AgentType = "claude" | "codex" | "gemini" | "kimi" | "opencode";

export interface Agent {
  name: AgentType;
  prompt(text: string): Promise<string>;
  close(): Promise<void>;
}

export const ALL_AGENTS: AgentType[] = ["claude", "codex", "gemini", "kimi", "opencode"];
export const AGENT_LABELS = ["a", "b", "c", "d", "e"] as const;
export type AgentLabel = (typeof AGENT_LABELS)[number];

/** ACP-based agent — long-lived subprocess with session */
export class AcpAgent implements Agent {
  name: AgentType;
  private process: AcpAgentProcess;
  private ready: Promise<void>;

  constructor(name: AgentType, cwd: string, onChunk?: (text: string) => void) {
    this.name = name;
    const config = ACP_CONFIGS[name];
    if (!config) throw new Error(`No ACP config for agent: ${name}`);
    this.process = new AcpAgentProcess(config, cwd, onChunk);
    this.ready = this.process.initialize().then(() => this.process.createSession(cwd));
  }

  async prompt(text: string): Promise<string> {
    await this.ready;
    return this.process.prompt(text);
  }

  async close(): Promise<void> {
    await this.process.close();
  }
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

/** Legacy subprocess agent — one-shot CLI invocation, for fallback */
export class LegacyAgent implements Agent {
  name: AgentType;
  private cwd: string;

  constructor(name: AgentType, cwd: string) {
    this.name = name;
    this.cwd = cwd;
  }

  async prompt(text: string): Promise<string> {
    const env = cleanEnv();
    let result: string;

    switch (this.name) {
      case "claude":
        result = await $`${LOCAL_BIN}/claude -p ${text} --dangerously-skip-permissions`
          .cwd(this.cwd).env(env).text();
        break;
      case "codex":
        result = await $`codex exec ${text} -C ${this.cwd} --dangerously-bypass-approvals-and-sandbox`
          .cwd(this.cwd).env(env).text();
        break;
      case "gemini":
        result = await $`gemini -p ${text} --yolo`
          .cwd(this.cwd).env(env).text();
        break;
      case "kimi":
        result = await $`echo ${text} | ${LOCAL_BIN}/kimi --print --final-message-only -w ${this.cwd}`
          .cwd(this.cwd).env(env).text();
        break;
      case "opencode":
        result = await $`opencode run -m zai-coding-plan/glm-5 ${text}`
          .cwd(this.cwd).env(env).text();
        break;
      default:
        throw new Error(`Unknown agent: ${this.name}`);
    }

    return result.trim();
  }

  async close(): Promise<void> {
    // No-op for one-shot processes
  }
}

/** Create an agent — ACP by default, legacy with CONSILIUM_LEGACY=1 */
export function createAgent(name: AgentType, cwd: string, onChunk?: (text: string) => void): Agent {
  if (process.env.CONSILIUM_LEGACY === "1") {
    return new LegacyAgent(name, cwd);
  }
  return new AcpAgent(name, cwd, onChunk);
}
