import { redirect } from "@sveltejs/kit";

// SvelteKit 2: redirect() throws internally, so no explicit `throw` is needed.
// The /admin layout guard still runs for the target route.
export function load() {
  redirect(307, "/admin/users");
}
