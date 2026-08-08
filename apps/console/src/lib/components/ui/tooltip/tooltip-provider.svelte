<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";

	// First tooltip waits; subsequent peers open instantly (bits-ui skipDelayDuration).
	let { delayDuration = 500, ...restProps }: TooltipPrimitive.ProviderProps = $props();
</script>

<TooltipPrimitive.Provider {delayDuration} {...restProps} />
