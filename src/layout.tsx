import { liveReloadScript } from "./lib/livereload.ts";

export function Layout({ title, children }: { title: string; children?: any }) {
  return (
    <html class="h-full bg-gray-950">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/styles.css" />
        <script src="/htmx.min.js" defer></script>
        <script src="/htmx-ext-sse.min.js" defer></script>
        <script src="/datastar.min.js" defer type="module"></script>
        {liveReloadScript}
      </head>
      <body class="h-full text-gray-200 font-mono text-sm">
        {children}
      </body>
    </html>
  );
}

export function SidebarLayout({ title, children, sidebar }: { title: string; children?: any; sidebar?: any }) {
  return (
    <Layout title={title}>
      <div class="flex h-screen">
        <aside class="w-56 shrink-0 border-r border-gray-800 overflow-y-auto p-3">
          <a href="/" class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-200 no-underline mb-3 px-1">
            <span>&#8249;</span> sessions
          </a>
          {sidebar}
        </aside>
        <main class="flex-1 min-w-0 overflow-y-auto p-5">
          {children}
        </main>
      </div>
    </Layout>
  );
}

export { html } from "./lib/html.ts";
