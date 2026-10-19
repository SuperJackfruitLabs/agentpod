import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitize } from "./render-markdown";

const plain = async (code: string, lang: string) => `<pre class="shiki" data-lang="${lang}"><code>${code.replace(/</g, "&lt;")}</code></pre>`;

describe("the markdown preview is sanitised", () => {
  it("drops an <img onerror> handler", async () => {
    const html = await renderMarkdown('Hi <img src="x" onerror="alert(1)">', plain);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain("alert(1)");
  });

  it("drops javascript: links, in markdown and in raw HTML", async () => {
    const html = await renderMarkdown('[click](javascript:alert(1)) <a href="JaVaScRiPt:alert(2)">two</a>', plain);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain("click");
    expect(html).toContain("two");
  });

  it("drops <script>, keeps ordinary markdown and http links", async () => {
    const html = await renderMarkdown('# Title\n\n<script>alert(3)</script>\n\n[ok](https://example.com)', plain);
    expect(html).not.toContain("<script");
    expect(html).toContain("<h1");
    expect(html).toContain('href="https://example.com"');
  });

  it("keeps the highlighter's code blocks (and the code inside them escaped)", async () => {
    const html = await renderMarkdown("```ts\nconst a = '<b>';\n```", plain);
    expect(html).toContain('<div class="markdown-code-block"><pre class="shiki" data-lang="ts">');
    expect(html).toContain("&lt;b>");
  });

  it("sanitize removes svg onload", () => {
    expect(sanitize('<svg onload="alert(1)"></svg>')).not.toMatch(/onload/);
  });

  it("puts code containing $' and $& in literally", async () => {
    const raw = async (code: string) => `<pre><code>${code}</code></pre>`;
    const html = await renderMarkdown("```sh\necho \"$'x\" $& done\n```", raw);
    expect(html).toContain("echo \"$'x\" $& done");
    expect(html).not.toContain("code-placeholder");
  });
});
