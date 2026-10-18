import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";

const codeToHtml = vi.hoisted(() => vi.fn(async (_code: string, _opts: unknown) => '<pre class="shiki"><code>x</code></pre>'));
vi.mock("shiki", async (orig) => ({ ...(await orig<typeof import("shiki")>()), codeToHtml }));

import CodeBlock from "./code-block.svelte";
import { VIBE_SHIKI_THEME } from "$lib/utils/shiki-theme";

afterEach(() => cleanup());

test("code is highlighted with the vibe's css-variables theme, not a fixed light/dark pair", async () => {
  render(CodeBlock, { props: { code: "const a = 1", language: "ts" } });
  await waitFor(() => expect(codeToHtml).toHaveBeenCalled());
  const opts = codeToHtml.mock.calls[0][1] as Record<string, unknown>;
  expect((opts.theme as { name: string }).name).toBe(VIBE_SHIKI_THEME);
  expect(opts.themes).toBeUndefined();
});
