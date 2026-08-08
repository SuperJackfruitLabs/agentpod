<script lang="ts">
  // Test stub for MarkdownViewer: shiki + marked don't play nicely with
  // jsdom (dynamic wasm-backed highlighting), so component tests substitute
  // this deterministic stand-in via vi.mock. Renders the raw content inside
  // a data-testid'd div so tests can assert on it without depending on the
  // real HTML markdown produces.
  interface Props {
    content: string;
    class?: string;
  }
  let { content }: Props = $props();
</script>

<div data-testid="markdown-viewer-stub">{content}</div>
