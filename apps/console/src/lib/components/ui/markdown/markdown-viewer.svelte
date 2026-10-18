<script lang="ts">
  import { marked } from "marked";
  import { codeToHtml } from "shiki";

  interface Props {
    content: string;
    class?: string;
  }

  let {
    content,
    class: className = "",
  }: Props = $props();

  let renderedHtml = $state<string>("");
  let isLoading = $state(true);

  // Shiki's GitHub pair (dual-theme output; the light/dark switch is in the styles below).
  const shikiThemes = { light: "github-light", dark: "github-dark" } as const;

  // Configure marked with custom renderer for code blocks
  async function renderMarkdown() {
    isLoading = true;

    try {
      // Create a custom renderer for syntax-highlighted code blocks
      const renderer = new marked.Renderer();
      
      // Store code blocks to process with Shiki later
      const codeBlocks: Array<{ id: string; code: string; lang: string }> = [];
      let codeBlockId = 0;

      renderer.code = ({ text, lang }) => {
        const id = `code-block-${codeBlockId++}`;
        codeBlocks.push({ id, code: text, lang: lang || "plaintext" });
        // Return a placeholder that we'll replace with highlighted code
        return `<div class="code-placeholder" data-id="${id}"></div>`;
      };

      // Parse markdown first
      let html = await marked.parse(content, {
        renderer,
        gfm: true, // GitHub Flavored Markdown
        breaks: true, // Convert \n to <br>
      });

      // Process code blocks with Shiki using dynamic themes
      for (const block of codeBlocks) {
        try {
          const highlighted = await codeToHtml(block.code, {
            lang: normalizeLanguage(block.lang),
            themes: {
              light: shikiThemes.light,
              dark: shikiThemes.dark,
            },
            defaultColor: false,
          });
          
          // Replace placeholder with highlighted code
          html = html.replace(
            `<div class="code-placeholder" data-id="${block.id}"></div>`,
            `<div class="markdown-code-block">${highlighted}</div>`
          );
        } catch {
          // Fallback to plain code block if Shiki fails
          html = html.replace(
            `<div class="code-placeholder" data-id="${block.id}"></div>`,
            `<pre class="markdown-code-block"><code>${escapeHtml(block.code)}</code></pre>`
          );
        }
      }

      renderedHtml = html;
    } catch (err) {
      console.error("Markdown rendering error:", err);
      renderedHtml = `<pre>${escapeHtml(content)}</pre>`;
    } finally {
      isLoading = false;
    }
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Shiki handles language detection - just pass directly
  function normalizeLanguage(lang: string): string {
    return lang.toLowerCase() || "plaintext";
  }

  // Re-render when the content changes (the light/dark switch is pure CSS)
  $effect(() => {
    content;
    renderMarkdown();
  });
</script>

<div class="markdown-viewer {className}" class:loading={isLoading}>
  {#if isLoading}
    <div class="animate-pulse space-y-4 p-4">
      <div class="h-6 bg-muted rounded w-3/4"></div>
      <div class="h-4 bg-muted rounded w-full"></div>
      <div class="h-4 bg-muted rounded w-5/6"></div>
      <div class="h-4 bg-muted rounded w-4/5"></div>
    </div>
  {:else}
    <div class="markdown-content">
      {@html renderedHtml}
    </div>
  {/if}
</div>

<style>
  .markdown-viewer {
    width: 100%;
    overflow: auto;
  }

  .markdown-content {
    padding: 1rem;
    line-height: 1.7;
  }

  /* Typography */
  .markdown-content :global(h1) {
    font-size: 2rem;
    font-weight: 700;
    margin: 1.5rem 0 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .markdown-content :global(h2) {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 1.25rem 0 0.75rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--border);
  }

  .markdown-content :global(h3) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 1rem 0 0.5rem;
  }

  .markdown-content :global(h4),
  .markdown-content :global(h5),
  .markdown-content :global(h6) {
    font-size: 1rem;
    font-weight: 600;
    margin: 0.75rem 0 0.5rem;
  }

  .markdown-content :global(p) {
    margin: 0.75rem 0;
  }

  /* Lists */
  .markdown-content :global(ul),
  .markdown-content :global(ol) {
    margin: 0.75rem 0;
    padding-left: 1.5rem;
  }

  .markdown-content :global(ul) {
    list-style-type: disc;
  }

  .markdown-content :global(ol) {
    list-style-type: decimal;
  }

  .markdown-content :global(li) {
    margin: 0.25rem 0;
  }

  .markdown-content :global(li > ul),
  .markdown-content :global(li > ol) {
    margin: 0.25rem 0;
  }

  /* Links */
  .markdown-content :global(a) {
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .markdown-content :global(a:hover) {
    opacity: 0.8;
  }

  /* Inline code */
  .markdown-content :global(code) {
    font-family: var(--font-mono), ui-monospace, monospace;
    font-size: 0.875em;
    background: var(--muted);
    padding: 0.2em 0.4em;
    border-radius: 0.25rem;
  }

  /* Code blocks */
  .markdown-content :global(.markdown-code-block) {
    margin: 1rem 0;
    border-radius: 0.5rem;
    overflow: hidden;
  }

  .markdown-content :global(.markdown-code-block pre) {
    margin: 0;
    padding: 1rem;
    overflow-x: auto;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .markdown-content :global(.markdown-code-block code) {
    background: transparent;
    padding: 0;
  }

  /* Dual theme support for code blocks */
  /* Shiki sets --shiki-light and --shiki-dark on each span */
  
  /* Light mode (default) */
  .markdown-content :global(.shiki) {
    background-color: var(--shiki-light-bg) !important;
  }
  
  .markdown-content :global(.shiki span) {
    color: var(--shiki-light);
  }

  /* Dark mode */
  :global([data-theme="dark"]) .markdown-content :global(.shiki) {
    background-color: var(--shiki-dark-bg) !important;
  }
  
  :global([data-theme="dark"]) .markdown-content :global(.shiki span) {
    color: var(--shiki-dark);
  }

  /* Blockquotes */
  .markdown-content :global(blockquote) {
    margin: 1rem 0;
    padding: 0.5rem 1rem;
    border-left: 4px solid var(--primary);
    background: var(--muted);
    border-radius: 0 0.25rem 0.25rem 0;
  }

  .markdown-content :global(blockquote p) {
    margin: 0;
  }

  /* Horizontal rules */
  .markdown-content :global(hr) {
    margin: 1.5rem 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  /* Tables */
  .markdown-content :global(table) {
    width: 100%;
    margin: 1rem 0;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .markdown-content :global(th),
  .markdown-content :global(td) {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    text-align: left;
  }

  .markdown-content :global(th) {
    background: var(--muted);
    font-weight: 600;
  }

  .markdown-content :global(tr:nth-child(even)) {
    background: var(--muted);
  }

  /* Images */
  .markdown-content :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 0.5rem;
    margin: 1rem 0;
  }

  /* Task lists (GFM) */
  .markdown-content :global(input[type="checkbox"]) {
    margin-right: 0.5rem;
  }

  /* Strong and emphasis */
  .markdown-content :global(strong) {
    font-weight: 600;
  }

  .markdown-content :global(em) {
    font-style: italic;
  }
</style>
