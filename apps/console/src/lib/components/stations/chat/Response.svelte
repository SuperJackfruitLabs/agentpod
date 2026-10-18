<script lang="ts">
  /**
   * Response — streamed assistant markdown.
   *
   * Agent output is UNTRUSTED: raw HTML is never rendered and links are
   * limited to http(s). `streaming` turns on incomplete-markdown parsing so
   * half-typed constructs (unclosed **bold**, dangling links) render sanely
   * mid-stream instead of flashing raw syntax.
   */
  import { Streamdown } from "svelte-streamdown";
  import Code from "svelte-streamdown/code";
  import { appearance } from "$lib/appearance.svelte";

  interface Props {
    text: string;
    streaming?: boolean;
  }

  let { text, streaming = false }: Props = $props();

  // Shiki's GitHub pair, by the appearance's light/dark (the colour schemes that picked other
  // Shiki themes are gone; token-driven code colours come with the widget theming).
  const shikiTheme = $derived(appearance.theme === "dark" ? "github-dark" : "github-light");

  // Minimal overrides on the tailwind base theme (mergeTheme defaults true):
  // swap its hard-coded grays/blues for Crisp tokens so borders and muted
  // text track the active scheme in both modes, and scale headings for chat.
  const crispTheme = {
    code: {
      base: "my-3 flex w-full flex-col overflow-hidden rounded-md border border-border",
      container: "relative overflow-visible bg-muted/50 p-2 font-mono text-sm",
      header:
        "flex items-center justify-between border-b border-border bg-muted/50 p-2 text-xs text-muted-foreground",
      pre: "overflow-x-auto p-0 font-mono",
      skeleton:
        "block scale-y-90 animate-pulse whitespace-nowrap rounded-md bg-muted font-mono text-transparent",
    },
    codespan: { base: "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]" },
    blockquote: { base: "my-3 border-l-2 border-border pl-4 text-muted-foreground" },
    table: { base: "my-3 max-w-full overflow-x-auto rounded-md border border-border" },
    hr: { base: "my-4 border-border" },
    link: {
      base: "wrap-anywhere font-medium text-primary underline underline-offset-2 hover:opacity-80",
      blocked: "text-muted-foreground",
    },
    h1: { base: "mt-4 mb-2 text-base font-semibold" },
    h2: { base: "mt-4 mb-2 text-sm font-semibold" },
    h3: { base: "mt-3 mb-1 text-sm font-semibold" },
    h4: { base: "mt-3 mb-1 text-sm font-medium" },
  };
</script>

<Streamdown
  content={text}
  components={{ code: Code }}
  baseTheme="tailwind"
  parseIncompleteMarkdown={streaming}
  renderHtml={false}
  allowedLinkPrefixes={["https://", "http://"]}
  {shikiTheme}
  theme={crispTheme}
  class="t-body max-w-none"
/>
