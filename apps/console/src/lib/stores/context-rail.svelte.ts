/**
 * The shell's third column, filled by whichever route has something to say.
 *
 * `AppShell` declares `contextRail` as a snippet prop, but a SvelteKit route
 * is the layout's *child* — it cannot pass a prop upward, and there is no
 * portal in Svelte to render into an ancestor. This module is the one place
 * that gap is bridged: a page registers its snippet from an `$effect` and the
 * effect's cleanup releases it, while `+layout.svelte` hands whatever is
 * registered to the shell.
 *
 * One rail at a time, deliberately: the column is singular, so a second
 * registration replacing the first is the honest model rather than a stack
 * whose ordering nobody could reason about.
 */
import type { Snippet } from "svelte";

let rail = $state<Snippet | null>(null);

export const contextRailSlot = {
  get snippet() {
    return rail;
  },
};

/**
 * Register the rail, or release it with `null`.
 *
 * Callers must release on destroy — a snippet that outlived its owner would
 * be rendered against state that no longer exists.
 */
export function setContextRail(snippet: Snippet | null): void {
  rail = snippet;
}
