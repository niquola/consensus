import tailwindPlugin from "bun-plugin-tailwind";
import { routes as homeRoutes } from "./pages/home.tsx";
import { routes as sessionRoutes, getArtifact } from "./pages/session.tsx";
import { liveReloadWs } from "./lib/livereload.ts";

const PORT = Number(process.env.PORT) || 3000;

// Build Tailwind CSS at startup
const built = await Bun.build({
  entrypoints: ["./src/styles.css"],
  plugins: [tailwindPlugin],
});
const css = await built.outputs[0]!.text();
console.log(`Tailwind CSS built: ${css.length} bytes`);

Bun.serve({
  port: PORT,
  idleTimeout: 255, // max — needed for SSE connections
  routes: {
    "/styles.css": new Response(css, {
      headers: { "Content-Type": "text/css" },
    }),
    ...homeRoutes,
    ...sessionRoutes,
  },
  async fetch(req, server) {
    const url = new URL(req.url);

    // Live reload WebSocket
    if (url.pathname === "/__reload") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Artifact routes (multi-segment path, can't use Bun route pattern)
    if (url.pathname.match(/^\/sessions\/[^/]+\/artifact\/.+$/)) {
      return getArtifact(req);
    }

    // Static files from public/
    const file = Bun.file(`./public${url.pathname}`);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
  websocket: liveReloadWs,
});

console.log(`Consilium: http://localhost:${PORT}`);
