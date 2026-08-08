/**
 * Reactive stand-in for $app/state's `page` store, for tests that need to
 * prove a component's $effect re-runs when `page.url` changes on the same
 * route (e.g. a search param appearing without a full navigation/remount).
 *
 * The default stub in ./app-state.ts is a plain object — fine for tests that
 * only care about the URL at mount time, but it never notifies subscribers
 * on mutation, so it can't exercise reactive $effect/$derived logic. This
 * module wraps `url` in a real `$state` rune (hence the .svelte.ts
 * extension) so tests can drive genuine reactivity via `setSearchParam`.
 *
 * Usage in a test file:
 *   vi.mock("$app/state", async () => {
 *     const mod = await import("../../../mocks/reactive-page-state.svelte");
 *     return { page: mod.page };
 *   });
 *   import { setSearchParam, resetReactivePageState } from "../../../mocks/reactive-page-state.svelte";
 */

let url = $state<URL>(new URL("http://localhost/nodes"));

export const page = {
  get url() {
    return url;
  },
  params: {},
  data: {},
  form: null,
  status: 200,
  error: null,
  route: { id: "/nodes" },
};

/** Set (or clear, with value=null) a single query param on the reactive URL. */
export function setSearchParam(key: string, value: string | null): void {
  const next = new URL(url.toString());
  if (value === null) {
    next.searchParams.delete(key);
  } else {
    next.searchParams.set(key, value);
  }
  url = next;
}

/** Reset to a bare /nodes URL with no query params. Call in beforeEach/afterEach. */
export function resetReactivePageState(): void {
  url = new URL("http://localhost/nodes");
}
