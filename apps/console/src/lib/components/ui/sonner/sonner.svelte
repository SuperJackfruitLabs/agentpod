<script lang="ts">
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";
	import { appearance } from "$lib/appearance.svelte";

	let { ...restProps }: SonnerProps = $props();
</script>

<!-- The theme is the appearance's resolved light or dark (the same value on <html> data-theme). -->
<Sonner
	theme={appearance.theme}
	class="toaster group"
	style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border);"
	{...restProps}
/>
