import { redirect } from "@sveltejs/kit";
import { auth } from "$lib/stores/auth.svelte";
import { adminSections } from "$lib/components/shell/nav";

// SvelteKit 2: redirect() throws internally, so no explicit `throw` is needed.
// The /admin layout guard still runs for the target route. A hub operator who is not a workspace
// admin lands on the hub's settings; everyone else on Users (a member then sees who to ask).
export function load() {
  const first = adminSections({ isWorkspaceAdmin: auth.isWorkspaceAdmin, isHubOperator: auth.isHubOperator })[0];
  redirect(307, first?.href ?? "/admin/users");
}
