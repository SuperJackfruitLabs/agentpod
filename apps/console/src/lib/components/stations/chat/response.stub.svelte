<script lang="ts">
  /**
   * Test stub for Response.svelte — later tasks mock the streamdown-backed
   * renderer with this to keep their component tests fast and jsdom-safe:
   *   vi.mock("./Response.svelte", () => import("./response.stub.svelte"))
   */
  interface Props {
    text: string;
    streaming?: boolean;
  }

  let { text }: Props = $props();
</script>

<div data-testid="response-stub">{text}</div>
