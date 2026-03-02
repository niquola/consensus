// Minimal JSX-to-HTML string runtime — no React needed

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "source", "track", "wbr",
]);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderAttrs(props: Record<string, any>): string {
  let result = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || value === false || value == null) continue;
    if (value === true) {
      result += ` ${key}`;
    } else {
      result += ` ${key}="${escapeHtml(String(value))}"`;
    }
  }
  return result;
}

function renderChildren(children: any): string {
  if (children == null || children === false) return "";
  if (Array.isArray(children)) return children.map(renderChildren).join("");
  return String(children);
}

export function jsx(
  tag: string | Function,
  props: Record<string, any>,
): string {
  if (typeof tag === "function") {
    return tag(props);
  }

  const attrs = renderAttrs(props);
  const children = props?.children;

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrs} />`;
  }

  return `<${tag}${attrs}>${renderChildren(children)}</${tag}>`;
}

export { jsx as jsxs, jsx as jsxDEV };

export function Fragment(props: { children?: any }) {
  return renderChildren(props.children);
}
