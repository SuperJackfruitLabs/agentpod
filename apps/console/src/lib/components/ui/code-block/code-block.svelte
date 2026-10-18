<script lang="ts">
  import { codeToHtml, type BundledTheme } from "shiki";

  interface Props {
    code: string;
    language?: string;
    lightTheme?: BundledTheme;
    darkTheme?: BundledTheme;
    showLineNumbers?: boolean;
    class?: string;
  }

  let {
    code,
    language = "plaintext",
    lightTheme,
    darkTheme,
    showLineNumbers = false,
    class: className = "",
  }: Props = $props();

  // Shiki's GitHub pair unless the caller names its own.
  const effectiveLightTheme = $derived(lightTheme ?? "github-light");
  const effectiveDarkTheme = $derived(darkTheme ?? "github-dark");

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
      
      const html = await codeToHtml(code, {
        lang,
        themes: {
          light: effectiveLightTheme,
          dark: effectiveDarkTheme,
        },
        defaultColor: false, // Let CSS handle the theme switching
      });

      highlightedHtml = html;
    } catch (err) {
      // If language is not supported, try plaintext
      console.warn(`Shiki: language "${language}" not supported, falling back to plaintext`);
      try {
        const html = await codeToHtml(code, {
          lang: "plaintext",
          themes: {
            light: effectiveLightTheme,
            dark: effectiveDarkTheme,
          },
          defaultColor: false,
        });
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
    effectiveLightTheme;
    effectiveDarkTheme;
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

  /* Dual theme support - Shiki sets --shiki-light and --shiki-dark on each span */
  /* We just need to tell spans which variable to use based on theme */
  
  /* Light mode (default) - use --shiki-light variables */
  .code-block :global(.shiki) {
    background-color: transparent !important;
  }
  
  .code-block :global(.shiki span) {
    color: var(--shiki-light);
  }

  /* Dark mode - use --shiki-dark variables */
  :global([data-theme="dark"]) .code-block :global(.shiki) {
    background-color: transparent !important;
  }
  
  :global([data-theme="dark"]) .code-block :global(.shiki span) {
    color: var(--shiki-dark);
  }
</style>

