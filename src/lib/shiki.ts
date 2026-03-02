import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";

let highlighter: Highlighter | null = null;

const SUPPORTED_LANGUAGES: BundledLanguage[] = [
  "javascript", "typescript", "json", "yaml", "bash", "shell",
  "sql", "python", "java", "clojure", "http", "markdown",
  "html", "css", "xml", "go", "rust", "c", "cpp", "csharp",
  "ruby", "php", "dockerfile", "graphql", "diff",
];

export async function initHighlighter(): Promise<void> {
  if (highlighter) return;
  const t = Date.now();
  highlighter = await createHighlighter({
    themes: ["github-dark"],
    langs: SUPPORTED_LANGUAGES,
  });
  console.log(`Shiki initialized (${Date.now() - t}ms)`);
}

export function highlightCode(code: string, lang?: string): string {
  if (!highlighter) return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;

  const detectedLang = normalizeLanguage(lang) || detectLanguage(code);
  const loaded = highlighter.getLoadedLanguages();
  const langToUse = detectedLang && loaded.includes(detectedLang as BundledLanguage)
    ? detectedLang : "plaintext";

  try {
    return highlighter.codeToHtml(code, { lang: langToUse, theme: "github-dark" });
  } catch {
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  }
}

function normalizeLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const n = lang.toLowerCase().trim();
  const aliases: Record<string, string> = {
    js: "javascript", ts: "typescript", sh: "bash", zsh: "bash",
    yml: "yaml", py: "python", rb: "ruby", cs: "csharp",
    "c#": "csharp", "c++": "cpp", text: "plaintext", txt: "plaintext",
  };
  return aliases[n] || n;
}

function detectLanguage(code: string): string | undefined {
  const t = code.trim();
  if (/^[\[\{]/.test(t) && /[\]\}]$/.test(t)) {
    try { JSON.parse(t); return "json"; } catch {}
  }
  if (/^\w+:\s/m.test(t) && !/^[\[\{]/.test(t)) return "yaml";
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s/i.test(t)) return "sql";
  if (/^(#!\/bin\/(ba)?sh|curl|wget|npm|yarn|bun|docker|git)\s/m.test(t)) return "bash";
  return undefined;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
