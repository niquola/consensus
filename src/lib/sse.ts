/** Generic SSE client registry factory. Each page creates its own instance. */
export function createSSERegistry<K = number>() {
  const clients = new Map<K, Set<ReadableStreamDefaultController>>();

  function add(key: K, controller: ReadableStreamDefaultController) {
    let set = clients.get(key);
    if (!set) {
      set = new Set();
      clients.set(key, set);
    }
    set.add(controller);
  }

  function remove(key: K, controller: ReadableStreamDefaultController) {
    const set = clients.get(key);
    if (set) {
      set.delete(controller);
      if (set.size === 0) clients.delete(key);
    }
  }

  function broadcast(key: K, event: string, data: string) {
    const set = clients.get(key);
    if (!set) return;
    const dataLines = data.split("\n").map(line => `data: ${line}`).join("\n");
    const payload = `event: ${event}\n${dataLines}\n\n`;
    for (const controller of set) {
      try {
        controller.enqueue(new TextEncoder().encode(payload));
      } catch {
        remove(key, controller);
      }
    }
  }

  return { add, remove, broadcast };
}

/** Create an SSE Response for a given registry key */
export function sseResponse<K>(
  registry: ReturnType<typeof createSSERegistry<K>>,
  key: K,
): Response {
  let controllerRef: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      registry.add(key, controller);
      controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
    },
    cancel() {
      registry.remove(key, controllerRef);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
