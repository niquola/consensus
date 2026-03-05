import { Layout, SidebarLayout, html } from "../layout.tsx";
import { esc } from "../lib/html.ts";
import {
  activeSessions,
  createSession,
  handleChat,
  handleRun,
  handleStart,
  listSessionArtifacts,
  getSessionAssignment,
  sseResponse,
  renderMarkdown,
  type ActiveSession,
  type Artifact,
} from "../server.ts";
import { resolve } from "node:path";

// ── Components ──

function ChatMsg({ role, text }: { role: string; text: string }) {
  const align = role === "user" ? "ml-auto" : "";
  const bg = role === "user" ? "bg-blue-500/10 border-blue-500/20" : "bg-gray-900 border-gray-800";
  return (
    <div class={`p-2.5 rounded-md border max-w-[85%] ${align} ${bg} mb-2 ${role === "user" ? "text-xs" : "prose prose-sm prose-invert max-w-none"}`}>
      {role === "user" ? esc(text) : renderMarkdown(text)}
    </div>
  );
}

export function chatMsgHtml(role: string, text: string): string {
  return <ChatMsg role={role} text={text} />;
}

export function streamHtml(text: string): string {
  if (!text) return `<span class="text-gray-600 text-xs">...</span>`;
  return `<div class="p-2.5 rounded-md border bg-gray-900 border-gray-800 max-w-[85%] mb-2 prose prose-sm prose-invert max-w-none">${renderMarkdown(text)}</div>`;
}

export function logEntryHtml(cls: string, content: string, opts?: { id?: string; oob?: boolean }): string {
  const colorMap: Record<string, string> = {
    status: "text-gray-500",
    "round-start": "text-gray-200 font-semibold mt-3 text-xs",
    "agent-start": "text-gray-500 pl-3",
    "agent-done": "text-green-400 pl-3",
    "agent-failed": "text-red-400 pl-3",
    timing: "text-cyan-400 text-[11px] pl-3",
    error: "text-red-400",
  };
  const color = colorMap[cls] || "text-gray-500";
  const idAttr = opts?.id ? ` id="${opts.id}"` : "";
  const oobAttr = opts?.oob ? ` hx-swap-oob="outerHTML"` : "";
  return `<div${idAttr}${oobAttr} class="py-0.5 text-xs ${color}">${content}</div>`;
}

export interface LiveProgress {
  workingAgents: Set<string>;   // "1-a", "report"
  summarizing: number | null;
  currentRound: number;
}

const SPINNER = `<span class="inline-block w-2 h-2 border border-gray-600 border-t-blue-400 rounded-full animate-spin mr-1 align-middle"></span>`;
const SPINNER_YELLOW = `<span class="inline-block w-2 h-2 border border-gray-600 border-t-yellow-400 rounded-full animate-spin mr-1 align-middle"></span>`;
const SELECT_JS = `onclick="document.querySelectorAll('.artifact-btn').forEach(b=>b.classList.remove('bg-gray-800','text-gray-200'));this.classList.add('bg-gray-800','text-gray-200')"`;

function artifactButton(name: string, path: string, label: string): string {
  return `<button class="artifact-btn block w-full text-left px-2 py-1 rounded text-xs text-gray-500 hover:bg-gray-900 hover:text-gray-200"
    hx-get="/sessions/${encodeURIComponent(name)}/artifact/${encodeURIComponent(path)}"
    hx-target="#content" hx-swap="innerHTML" ${SELECT_JS}>${label}</button>`;
}

export function artifactsSidebarHtml(name: string, artifacts: Artifact[], assignment: Record<string, string>, live?: LiveProgress): string {
  const labels = Object.keys(assignment).sort();
  const maxRound = live ? live.currentRound : Math.max(0, ...artifacts.filter(a => a.round).map(a => a.round!));

  let html = "";

  // Problem
  const problem = artifacts.find(a => a.type === "problem");
  if (problem) {
    html += `<div class="mb-3"><div class="text-[10px] text-gray-600 uppercase tracking-wide mb-1 px-2">Problem</div>`;
    html += artifactButton(name, problem.path, "problem.md");
    html += `</div>`;
  }

  // Rounds
  const roundNames: Record<number, string> = { 1: "Solve", 2: "Compare & Defend" };
  for (let r = 1; r <= maxRound; r++) {
    html += `<div class="mb-3"><div class="text-[10px] text-gray-600 uppercase tracking-wide mb-1 px-2">Round ${r} — ${roundNames[r] || ""}</div>`;

    for (const label of labels) {
      const solution = artifacts.find(a => a.round === r && a.label === label && a.type === "solution");
      if (solution) {
        // Done — clickable file
        let btnLabel = `<span class="text-green-400">&#10003;</span> ${label}`;
        if (assignment[label]) {
          btnLabel += ` <span class="text-gray-600 text-[10px] cursor-pointer hover:text-blue-400" onclick="event.stopPropagation();this.textContent='${esc(assignment[label]!)}'" title="reveal model">?</span>`;
        }
        html += artifactButton(name, solution.path, btnLabel);
      } else if (live?.workingAgents.has(`${r}-${label}`)) {
        // Working — spinner
        html += `<div class="px-2 py-1 text-xs text-gray-500">${SPINNER}${label}</div>`;
      }
    }

    // Summary
    const summary = artifacts.find(a => a.round === r && a.type === "summary");
    if (summary) {
      html += artifactButton(name, summary.path, `<span class="text-yellow-500 italic">summary</span>`);
    } else if (live?.summarizing === r) {
      html += `<div class="px-2 py-1 text-xs text-gray-500">${SPINNER_YELLOW}<span class="text-yellow-500 italic">summary</span></div>`;
    }

    html += `</div>`;
  }

  // Final Report
  const report = artifacts.find(a => a.type === "report");
  if (report || live?.workingAgents.has("report")) {
    html += `<div class="mb-3"><div class="text-[10px] text-gray-600 uppercase tracking-wide mb-1 px-2">Final Report</div>`;
    if (report) {
      html += artifactButton(name, report.path, "final-report.md");
    } else {
      html += `<div class="px-2 py-1 text-xs text-gray-500">${SPINNER}generating...</div>`;
    }
    html += `</div>`;
  }

  return html;
}

// ── Page renderers ──

function sseRedirectScript(eventsUrl: string): string {
  return `<script>
(function(){
  var es = new EventSource('${eventsUrl}');
  es.addEventListener('redirect', function(e){ window.location.href = e.data; });
  es.addEventListener('done', function(){ setTimeout(function(){ window.location.reload(); }, 1500); });
})();
</script>`;
}

function ChatPhase({ name, session }: { name: string; session: ActiveSession }) {
  const eventsUrl = `/sessions/${encodeURIComponent(name)}/events`;
  return (
    <Layout title={`${name} — Consilium`}>
      <div class="max-w-2xl mx-auto p-5" hx-ext="sse" sse-connect={eventsUrl}>
        <a href="/" class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-200 no-underline mb-3">
          <span>&#8249;</span> sessions
        </a>
        <h2 class="text-sm font-semibold text-gray-400 mb-3">{name}</h2>
        <div id="chat-msgs" sse-swap="chat-msg" hx-swap="beforeend">
          {session.chatHistory.map(m => <ChatMsg role={m.role} text={m.text} />)}
        </div>
        <div id="chat-stream" sse-swap="chat-stream" hx-swap="innerHTML"></div>
        <div class="flex gap-2 mt-3 items-end">
          <form hx-post={`/sessions/${encodeURIComponent(name)}/chat`} hx-swap="none"
            hx-on--after-request="this.reset()" class="flex-1 flex gap-2 items-end">
            <textarea name="text" rows={2} placeholder="Describe your problem..."
              class="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 resize-none focus:border-blue-500 focus:outline-none"
              onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();this.closest('form').requestSubmit()}"></textarea>
            <button type="submit" class="px-3 py-2 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-500">Send</button>
          </form>
          <form hx-post={`/sessions/${encodeURIComponent(name)}/run`} hx-swap="none">
            <button type="submit" class="px-3 py-2 bg-green-600 text-white text-xs font-semibold rounded hover:bg-green-500">Run</button>
          </form>
        </div>
      </div>
      {sseRedirectScript(eventsUrl)}
    </Layout>
  );
}

function ReviewPhase({ name, session }: { name: string; session: ActiveSession }) {
  return (
    <Layout title={`Review — Consilium`}>
      <main class="max-w-2xl mx-auto p-5">
        <a href="/" class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-200 no-underline mb-3">
          <span>&#8249;</span> sessions
        </a>
        <h2 class="text-sm font-semibold text-gray-400 mb-4">Review &amp; Start</h2>
        <form method="POST" action={`/sessions/${encodeURIComponent(name)}/start`}>
          <div class="mb-3">
            <label class="block text-gray-500 text-[10px] uppercase tracking-wide mb-1">Session Name</label>
            <input type="text" name="session_name" value={esc(session.reviewName || "")}
              class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 focus:border-blue-500 focus:outline-none" />
          </div>
          <div class="mb-4">
            <label class="block text-gray-500 text-[10px] uppercase tracking-wide mb-1">Problem</label>
            <textarea name="problem" rows={20}
              class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 font-mono leading-relaxed resize-y focus:border-blue-500 focus:outline-none"
            >{esc(session.reviewProblem || "")}</textarea>
          </div>
          <button type="submit" class="px-5 py-2 bg-green-600 text-white text-xs font-semibold rounded hover:bg-green-500">
            Start Deliberation &rarr;
          </button>
        </form>
      </main>
    </Layout>
  );
}

function ProgressPhase({ name }: { name: string }) {
  const eventsUrl = `/sessions/${encodeURIComponent(name)}/events`;
  return (
    <SidebarLayout title={`${name} — Consilium`}
      sidebar={
        <div hx-ext="sse" sse-connect={eventsUrl}>
          <div id="artifacts" sse-swap="artifacts" hx-swap="innerHTML"></div>
        </div>
      }>
      <div id="content" class="prose prose-sm prose-invert max-w-none">
        <p class="text-gray-500 text-sm">Select an artifact from the sidebar.</p>
      </div>
      {sseRedirectScript(eventsUrl)}
    </SidebarLayout>
  );
}

async function DonePage({ name }: { name: string }) {
  const artifacts = await listSessionArtifacts(name);
  const assignment = await getSessionAssignment(name);
  const sidebar = artifactsSidebarHtml(name, artifacts, assignment);

  // Auto-load final report or problem
  const defaultArtifact = artifacts.find(a => a.type === "report") || artifacts.find(a => a.type === "problem");
  let content = "";
  if (defaultArtifact) {
    try {
      const raw = await Bun.file(resolve(process.cwd(), "sessions", name, defaultArtifact.path)).text();
      content = renderMarkdown(raw);
    } catch {}
  }

  return (
    <SidebarLayout title={`${name} — Consilium`} sidebar={sidebar}>
      <div id="content" class="prose prose-sm prose-invert max-w-none">
        {content || <p class="text-gray-500">Select an artifact from the sidebar.</p>}
      </div>
    </SidebarLayout>
  );
}

// ── Routes ──

async function sessionPage(req: Request) {
  const url = new URL(req.url);
  const name = decodeURIComponent(url.pathname.split("/sessions/")[1]!.split("/")[0]!);
  const session = activeSessions.get(name);

  if (session) {
    if (session.phase === "chat") {
      return html(<ChatPhase name={name} session={session} />);
    }
    if (session.phase === "review") {
      return html(<ReviewPhase name={name} session={session} />);
    }
    return html(<ProgressPhase name={name} />);
  }

  // Completed or unknown session — show artifact browser
  return html(await DonePage({ name }));
}

async function sessionEvents(req: Request) {
  const url = new URL(req.url);
  const name = decodeURIComponent(url.pathname.split("/sessions/")[1]!.split("/")[0]!);
  return sseResponse(name);
}

async function postCreateSession(req: Request) {
  const form = await req.formData();
  const agents = form.getAll("agents") as string[];
  const analyst = (form.get("analyst") as string) || "claude";
  const supervisor = (form.get("supervisor") as string) || "claude";
  const reporter = (form.get("reporter") as string) || "claude";

  const { getDefaults } = await import("../prompts.ts");
  const d = getDefaults();
  const prompts = {
    problem: "",
    analyst: (form.get("analyst_prompt") as string) || d.analyst,
    round1: (form.get("round1") as string) || d.round1,
    round2: (form.get("round2") as string) || d.round2,
    summary: (form.get("summary") as string) || d.summary,
    report: (form.get("report") as string) || d.report,
    agents: (form.get("agents_prompt") as string) || d.agents,
  };

  const name = createSession({
    analyst: analyst as any,
    supervisor: supervisor as any,
    reporter: reporter as any,
    participants: agents as any[],
  }, prompts);

  return Response.redirect(`/sessions/${encodeURIComponent(name)}`, 303);
}

async function postChat(req: Request) {
  const url = new URL(req.url);
  const name = decodeURIComponent(url.pathname.split("/sessions/")[1]!.split("/")[0]!);
  const form = await req.formData();
  const text = (form.get("text") as string)?.trim();
  if (text) handleChat(name, text);
  return new Response(null, { status: 204 });
}

async function postRun(req: Request) {
  const url = new URL(req.url);
  const name = decodeURIComponent(url.pathname.split("/sessions/")[1]!.split("/")[0]!);
  handleRun(name);
  return new Response(null, { status: 204 });
}

async function postStart(req: Request) {
  const url = new URL(req.url);
  const name = decodeURIComponent(url.pathname.split("/sessions/")[1]!.split("/")[0]!);
  const form = await req.formData();
  const sessionName = ((form.get("session_name") as string) || "").trim() || "unknown";
  const problem = ((form.get("problem") as string) || "").trim();
  const fullName = await handleStart(name, sessionName, problem);
  if (fullName) {
    return Response.redirect(`/sessions/${encodeURIComponent(fullName)}`, 303);
  }
  return Response.redirect(`/sessions/${encodeURIComponent(name)}`, 303);
}

export async function getArtifact(req: Request) {
  const url = new URL(req.url);
  const parts = url.pathname.match(/^\/sessions\/([^/]+)\/artifact\/(.+)$/);
  if (!parts) return new Response("Not found", { status: 404 });
  const name = decodeURIComponent(parts[1]!);
  const relPath = decodeURIComponent(parts[2]!);
  if (relPath.includes("..")) return new Response("Forbidden", { status: 403 });
  try {
    const raw = await Bun.file(resolve(process.cwd(), "sessions", name, relPath)).text();
    const rendered = renderMarkdown(raw);
    return new Response(rendered, { headers: { "Content-Type": "text/html" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export const routes: Record<string, any> = {
  "/sessions": {
    POST: postCreateSession,
  },
  "/sessions/:name": sessionPage,
  "/sessions/:name/events": sessionEvents,
  "/sessions/:name/chat": { POST: postChat },
  "/sessions/:name/run": { POST: postRun },
  "/sessions/:name/start": { POST: postStart },
};
