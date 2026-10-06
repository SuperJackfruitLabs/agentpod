<script lang="ts">
  /**
   * Shown where the console used to manage something the organization plane now owns (users,
   * grants, devices): what moved, and a link to it. `href` comes from the hub's 410 body or from
   * the plane discovery, already checked to be http(s).
   */
  interface Props {
    /** What is managed there, as the start of a sentence: "Users", "Grants", "Devices". */
    what: string;
    href: string;
  }

  let { what, href }: Props = $props();
</script>

<div class="rounded-lg border bg-muted/30 p-4 text-sm" data-testid="managed-by-plane">
  <p class="text-muted-foreground">
    {what} are managed in your
    <a {href} class="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Super Jackfruit account</a>.
  </p>
</div>
