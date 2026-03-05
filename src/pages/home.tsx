import { Layout, html } from "../layout.tsx";
import { listSessions, activeSessions, type SessionInfo } from "../server.ts";
import { ALL_AGENTS } from "../agent.ts";
import { esc } from "../lib/html.ts";
import { getDefaults } from "../prompts.ts";

function formatMs(ms?: number): string {
  if (!ms) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function SessionCard({ s }: { s: SessionInfo }) {
  const isActive = activeSessions.has(s.name);
  const status = s.hasReport
    ? <span class="text-green-400 text-[10px]">complete</span>
    : isActive
    ? <span class="text-blue-400 text-[10px] flex items-center gap-1"><span class="inline-block w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></span>running</span>
    : s.rounds > 0
    ? <span class="text-yellow-400 text-[10px]">round {String(s.rounds)}</span>
    : null;

  const meta = [
    s.totalElapsedMs ? formatMs(s.totalElapsedMs) : "",
    s.agents.length ? s.agents.join(", ") : "",
  ].filter(Boolean).join(" · ");

  return (
    <a href={`/sessions/${encodeURIComponent(s.name)}`}
       class="block p-3 bg-gray-900 border border-gray-800 rounded-md hover:border-gray-700 no-underline text-gray-200">
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold">{s.name}</span>
        {status}
      </div>
      {meta && <div class="text-gray-500 text-[10px] mt-0.5">{meta}</div>}
      {s.problem && (
        <div class="text-gray-500 text-[11px] mt-1 line-clamp-2">{s.problem}</div>
      )}
    </a>
  );
}

function HomePage({ sessions }: { sessions: SessionInfo[] }) {
  return (
    <Layout title="Consilium">
      <main class="max-w-2xl mx-auto p-5">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-3">
            <h1 class="text-lg font-semibold text-gray-100">consilium</h1>
            <span class="text-gray-600 text-xs">multi-agent deliberation</span>
          </div>
        </div>
        <a href="/sessions/new" class="block p-3 border border-dashed border-gray-700 rounded-md hover:border-blue-500 hover:text-blue-400 no-underline text-gray-500 text-xs text-center mb-3">+ New Session</a>
        {sessions.length === 0
          ? <p class="text-gray-500 text-sm">No sessions yet.</p>
          : <div class="space-y-2">
              {sessions.map(s => <SessionCard s={s} />)}
            </div>
        }
      </main>
    </Layout>
  );
}

function agentOptions() {
  return ALL_AGENTS.map(a => `<option value="${a}"${a === "claude" ? " selected" : ""}>${a}</option>`).join("");
}

const PROMPT_TABS = [
  { key: "analyst_prompt", field: "analyst", label: "Analyst" },
  { key: "round1", field: "round1", label: "Round 1" },
  { key: "round2", field: "round2", label: "Round 2" },
  { key: "summary", field: "summary", label: "Summary" },
  { key: "report", field: "report", label: "Report" },
  { key: "agents_prompt", field: "agents", label: "AGENTS.md" },
] as const;

function NewSessionPage() {
  const agents = ALL_AGENTS;
  const opts = agentOptions();
  return (
    <Layout title="New Session — Consilium">
      <main class="max-w-xl mx-auto p-5">
        <a href="/" class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-200 no-underline mb-3">
          <span>&#8249;</span> sessions
        </a>
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">New Session</h2>
        <form method="POST" action="/sessions">
          <div class="mb-4">
            <label class="block text-gray-500 text-[10px] uppercase tracking-wide mb-2">Participants</label>
            <div class="flex gap-2 flex-wrap"
                 data-signals={`{"sel":${JSON.stringify(agents)}}`}>
              {agents.map(name => (
                <label class="cursor-pointer">
                  <input type="checkbox" name="agents" value={name} checked
                    class="hidden peer" />
                  <span class="px-3 py-1.5 border border-gray-700 rounded text-xs text-gray-500 peer-checked:border-blue-500 peer-checked:text-blue-400 peer-checked:bg-blue-500/10 block">
                    {name}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div class="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label class="block text-gray-500 text-[10px] uppercase tracking-wide mb-1">Analyst</label>
              <select name="analyst" class="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 focus:border-blue-500 focus:outline-none">{opts}</select>
            </div>
            <div>
              <label class="block text-gray-500 text-[10px] uppercase tracking-wide mb-1">Supervisor</label>
              <select name="supervisor" class="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 focus:border-blue-500 focus:outline-none">{opts}</select>
            </div>
            <div>
              <label class="block text-gray-500 text-[10px] uppercase tracking-wide mb-1">Reporter</label>
              <select name="reporter" class="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 focus:border-blue-500 focus:outline-none">{opts}</select>
            </div>
          </div>
          <div class="mb-4">
            <label class="block text-gray-500 text-[10px] uppercase tracking-wide mb-2">Prompt Templates</label>
            <div class="border border-gray-800 rounded">
              <div class="flex border-b border-gray-800" id="prompt-tabs">
                {PROMPT_TABS.map((t, i) =>
                  `<button type="button" class="px-3 py-1.5 text-xs ${i === 0 ? 'text-blue-400 border-b border-blue-400' : 'text-gray-500 hover:text-gray-300'}" onclick="document.querySelectorAll('#prompt-tabs button').forEach(b=>{b.className='px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300'});this.className='px-3 py-1.5 text-xs text-blue-400 border-b border-blue-400';document.querySelectorAll('.prompt-panel').forEach(p=>p.style.display='none');document.getElementById('panel-${t.key}').style.display='block'">${t.label}</button>`
                )}
              </div>
              {PROMPT_TABS.map((t, i) => {
                const d = getDefaults();
                const val = d[t.field] || "";
                return `<div id="panel-${t.key}" class="prompt-panel" style="${i === 0 ? '' : 'display:none'}"><textarea name="${t.key}" rows="30" class="w-full px-3 py-2 bg-gray-900 text-xs text-gray-300 font-mono leading-relaxed resize-y focus:outline-none">${esc(val)}</textarea></div>`;
              })}
            </div>
          </div>
          <button type="submit" class="px-5 py-2 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-500">
            Start Session
          </button>
        </form>
      </main>
    </Layout>
  );
}

// ── Routes ──

async function homeIndex() {
  const sessions = await listSessions();
  return html(<HomePage sessions={sessions} />);
}

function newSession() {
  return html(<NewSessionPage />);
}

export const routes = {
  "/": homeIndex,
  "/sessions/new": newSession,
};
