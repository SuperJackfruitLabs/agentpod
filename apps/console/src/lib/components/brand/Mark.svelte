<script lang="ts">
  /**
   * The AgentPod mark: three nodes dialling in to one hub.
   *
   * The same paths as `static/favicon.svg`, less its dark tile, and shared with
   * the landing page (`apps/landing/src/components/Mark.astro`) and the docs
   * (`docs-site/src/assets/mark-*.svg`). Change one, change them all.
   *
   * The spokes and nodes are agentpod.dev's cyan in both modes — the console's
   * own palette is chosen per install from theme presets, and a mark that
   * followed `--primary` would be a different logo on every one of them. The
   * hub takes currentColor, so it stays the brightest thing in the mark on a
   * dark ground and the darkest on a light one, as it is on the tile.
   */
  interface Props {
    class?: string;
  }

  let { class: className = "size-5" }: Props = $props();
</script>

<svg
  data-testid="agentpod-mark"
  class="shrink-0 text-foreground {className}"
  viewBox="4 4.5 24 24"
  aria-hidden="true"
  focusable="false"
>
  <!-- #1d6c8c on light (5.7:1 on white), #5fb3d4 on dark: the landing page's pair. -->
  <g class="stroke-[#1d6c8c] dark:stroke-[#5fb3d4]" stroke-width="2.6" stroke-linecap="round">
    <path d="M16 16 L7.5 8.5" />
    <path d="M16 16 L24.5 10" />
    <path d="M16 16 L10.5 24.5" />
  </g>
  <g class="fill-[#1d6c8c] dark:fill-[#5fb3d4]">
    <circle cx="7.5" cy="8.5" r="3.1" />
    <circle cx="24.5" cy="10" r="3.1" />
    <circle cx="10.5" cy="24.5" r="3.1" />
  </g>
  <circle cx="16" cy="16" r="5.4" fill="currentColor" />
</svg>
