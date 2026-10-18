/**
 * Markdown to safe HTML for the file preview. Files on a station are untrusted: the
 * HTML marked produces is sanitised with DOMPurify (no scripts, no event handlers, no
 * `javascript:` or other non-http links) before it reaches `{@html}`.
 */
import { marked } from "marked";
import DOMPurify from "dompurify";

/** Highlights one code block to HTML (Shiki in the app; a stand-in in tests). */
export type Highlight = (code: string, lang: string) => Promise<string>;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const SAFE_URL = /^(?:https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i;

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: SAFE_URL,
    FORBID_TAGS: ["style", "form", "button", "iframe", "object", "embed"],
  });
}

export async function renderMarkdown(content: string, highlight: Highlight): Promise<string> {
  const renderer = new marked.Renderer();
  const blocks: Array<{ id: string; code: string; lang: string }> = [];
  renderer.code = ({ text, lang }) => {
    const id = `code-block-${blocks.length}`;
    blocks.push({ id, code: text, lang: (lang || "plaintext").toLowerCase() });
    return `<div class="code-placeholder" data-id="${id}"></div>`;
  };
  let html = await marked.parse(content, { renderer, gfm: true, breaks: true });
  // Sanitise what the author wrote; the highlighter's own markup is added afterwards.
  html = sanitize(html);
  for (const b of blocks) {
    let out: string;
    try {
      out = `<div class="markdown-code-block">${await highlight(b.code, b.lang)}</div>`;
    } catch {
      out = `<pre class="markdown-code-block"><code>${escapeHtml(b.code)}</code></pre>`;
    }
    html = html.replace(`<div class="code-placeholder" data-id="${b.id}"></div>`, out);
  }
  return html;
}
