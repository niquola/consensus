import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";

export interface AcpAgentConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
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

export const ACP_CONFIGS: Record<string, AcpAgentConfig> = {
  claude: {
    name: "claude",
    command: "bunx",
    args: ["@zed-industries/claude-agent-acp"],
    env: { ACP_PERMISSION_MODE: "bypassPermissions" },
  },
  codex: {
    name: "codex",
    command: "bunx",
    args: ["@zed-industries/codex-acp"],
  },
  gemini: {
    name: "gemini",
    command: "gemini",
    args: ["--experimental-acp"],
  },
  kimi: {
    name: "kimi",
    command: "kimi",
    args: ["acp"],
  },
  opencode: {
    name: "opencode",
    command: "opencode",
    args: ["acp"],
    env: { OPENCODE_MODEL: "zai-coding-plan/glm-5" },
  },
};

export class AcpAgentProcess {
  private proc: ChildProcess;
  private conn: ClientSideConnection;
  private sessionId: string | null = null;
  private collectedText = "";
  private onChunk?: (text: string) => void;

  constructor(config: AcpAgentConfig, cwd: string, onChunk?: (text: string) => void) {
    this.onChunk = onChunk;

    this.proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd,
      env: { ...cleanEnv(), ...config.env },
    });

    const input = Writable.toWeb(this.proc.stdin!);
    const output = Readable.toWeb(this.proc.stdout!);

    const stream = ndJsonStream(input, output as ReadableStream<Uint8Array>);

    this.conn = new ClientSideConnection(
      (_agent: Agent) => this.createClient(),
      stream,
    );
  }

  private createClient(): Client {
    return {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        // Auto-approve: pick the first "allow" option, or first option
        const allowOption = params.options.find(o => o.kind === "allow_once" || o.kind === "allow_always");
        const option = allowOption ?? params.options[0];
        return { outcome: { outcome: "selected", optionId: option!.optionId } };
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") {
            this.collectedText += update.content.text;
            this.onChunk?.(update.content.text);
          }
        }
      },
    };
  }

  async initialize(): Promise<void> {
    await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
  }

  async createSession(cwd: string): Promise<void> {
    const res = await this.conn.newSession({ cwd, mcpServers: [] });
    this.sessionId = res.sessionId;
  }

  async prompt(text: string): Promise<string> {
    this.collectedText = "";
    await this.conn.prompt({
      sessionId: this.sessionId!,
      prompt: [{ type: "text", text }],
    });
    return this.collectedText;
  }

  async close(): Promise<void> {
    try {
      this.proc.kill();
    } catch {}
    try {
      await this.conn.closed;
    } catch {}
  }
}
