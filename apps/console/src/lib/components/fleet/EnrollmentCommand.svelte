<script lang="ts">
  /**
   * EnrollmentCommand
   *
   * Crisp bordered block that renders the one-line "run this on the target
   * node to connect it" enrollment curl command plus a copy-to-clipboard
   * chip. Deduped from three near-identical copies in NodesOverview (the
   * persistent post-mint card, the empty-state card, and the ?action=
   * mount-time mint) — all three now render this component.
   *
   * The token must stay a direct-child text node of <code> alongside the
   * rest of the command (no wrapping <span>) so testing-library's
   * getByText(/tok_.../) — which joins an element's direct TEXT_NODE
   * children, not nested descendants — still finds it as one match.
   */

  import { chipClass } from "$lib/utils/toggle-chip";
  import { enrollmentCommand } from "$lib/utils/enrollment-command";
  import { cn } from "$lib/utils";

  interface Props {
    /** The freshly-minted enrollment token to embed in the command. */
    token: string;
    /** The hub URL the enrolling node should connect back to. */
    hubUrl: string;
    /** Whether the command was just copied (drives the chip's "running" tone). */
    copied: boolean;
    /** Called when the copy chip is clicked. */
    onCopy: () => void;
    class?: string;
  }

  let { token, hubUrl, copied, onCopy, class: className = undefined }: Props = $props();
</script>

<div class={cn("rounded-lg border bg-card p-4 space-y-2", className)}>
  <div class="flex items-start gap-2">
    <code
      class="flex-1 block rounded-md bg-muted px-3 py-2 text-sm font-mono break-all text-foreground"
      >{enrollmentCommand(hubUrl, token)}</code
    >
    <button
      type="button"
      onclick={onCopy}
      class={cn("shrink-0", chipClass(copied, "running"))}
      aria-label="Copy enrollment command"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  </div>
</div>
