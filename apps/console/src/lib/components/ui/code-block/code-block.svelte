<script lang="ts">
  import { codeToHtml } from "shiki";
  import { vibeShikiTheme } from "$lib/utils/shiki-theme";

  interface Props {
    code: string;
    language?: string;
    showLineNumbers?: boolean;
    class?: string;
  }

  let {
    code,
    language = "plaintext",
    showLineNumbers = false,
    class: className = "",
  }: Props = $props();

  // The vibe's css-variables theme: colours follow the vibe and theme in CSS, no re-highlight.
  const themeOptions = { theme: vibeShikiTheme };

  let highlightedHtml = $state<string>("");
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  // Shiki supports 200+ languages - just pass the language/extension directly
  // It will handle detection and fallback to plaintext for unknown languages

  async function highlightCode() {
    isLoading = true;
    error = null;

    try {
      // Use dual themes for automatic light/dark mode support
      // Shiki handles language detection - pass extension directly
      const lang = language.toLowerCase() || "plaintext";
      
      const html = await codeToHtml(code, { lang, ...themeOptions });

      highlightedHtml = html;
    } catch (err) {
      // If language is not supported, try plaintext
      console.warn(`Shiki: language "${language}" not supported, falling back to plaintext`);
      try {
        const html = await codeToHtml(code, { lang: "plaintext", ...themeOptions });
        highlightedHtml = html;
      } catch {
        // Final fallback to raw HTML
        error = err instanceof Error ? err.message : "Failed to highlight code";
        highlightedHtml = `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
      }
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

  // Re-highlight when code, language, or theme changes
  $effect(() => {
    // Track dependencies
    code;
    language;
    // Highlight
    highlightCode();
  });
</script>

<div class="code-block {className}" class:loading={isLoading}>
  {#if isLoading}
    <div class="code-loading">
      <pre class="font-mono text-sm p-4 bg-muted rounded-md"><code>{code}</code></pre>
    </div>
  {:else if error}
    <div class="code-error">
      <pre class="font-mono text-sm p-4 bg-muted rounded-md"><code>{code}</code></pre>
    </div>
  {:else}
    {@html highlightedHtml}
  {/if}
</div>

<style>
  .code-block {
    width: 100%;
    overflow: auto;
  }

  .code-block :global(pre) {
    margin: 0;
    padding: 1rem;
    border-radius: 0.375rem;
    overflow-x: auto;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .code-block :global(code) {
    font-family: var(--font-mono), ui-monospace, monospace;
  }

  .code-block :global(.line) {
    display: inline-block;
    width: 100%;
    min-height: 1.5em;
  }

  .code-block.loading :global(pre) {
    opacity: 0.5;
  }

  /* Ensure proper wrapping for long lines */
  .code-block :global(pre) {
    white-space: pre;
    word-wrap: normal;
  }

  /* One Shiki treatment (the markdown preview uses the same): the vibe's code ground. */
  .code-block :global(.shiki) {
    background-color: var(--shiki-background) !important;
    color: var(--shiki-foreground);
  }

</style>

