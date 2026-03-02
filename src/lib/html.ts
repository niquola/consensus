export function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function html(body: string) {
  return new Response("<!DOCTYPE html>" + body, {
    headers: { "Content-Type": "text/html" },
  });
}
