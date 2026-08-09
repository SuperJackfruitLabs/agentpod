import { test, expect, afterEach, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";

// Response imports the theme store, which touches window.matchMedia at module
// init — ES imports are hoisted ahead of plain statements, so the stub must go
// through vi.hoisted() to run before "./Response.svelte" is evaluated (same
// pattern as store-status-tokens.svelte.test.ts; jsdom has no matchMedia).
vi.hoisted(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
});

// Static import: compiled during file collection, not during the test body.
import Response from "./Response.svelte";

afterEach(() => cleanup());

test("renders markdown: **bold** lands as a <strong> element", async () => {
  const { container } = render(Response, {
    props: { text: "Hello **bold** world", streaming: false },
  });

  await waitFor(() => {
    const strong = container.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong!.textContent).toContain("bold");
  });
  expect(container.textContent).toContain("Hello");
  expect(container.textContent).toContain("world");
});

test("streaming: unterminated **bold is completed by incomplete-markdown parsing", async () => {
  const { container } = render(Response, {
    props: { text: "Hello **bol", streaming: true },
  });

  await waitFor(() => {
    const strong = container.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong!.textContent).toContain("bol");
  });
});

test("javascript: links render inert; https links keep their href", async () => {
  const { container } = render(Response, {
    props: {
      text: "[evil](javascript:alert(1)) and [ok](https://example.com)",
      streaming: false,
    },
  });

  await waitFor(() => expect(container.textContent).toContain("evil"));

  // No element anywhere may carry a javascript: href.
  for (const el of container.querySelectorAll("[href]")) {
    expect(el.getAttribute("href")).not.toMatch(/^\s*javascript:/i);
  }
  // The allowed https link renders as a real anchor (streamdown normalizes
  // the URL with a trailing slash) hardened with noopener.
  await waitFor(() => {
    const anchor = [...container.querySelectorAll("a[href]")].find((a) =>
      a.getAttribute("href")!.startsWith("https://example.com"),
    );
    expect(anchor).toBeTruthy();
    expect(anchor!.getAttribute("rel")).toContain("noopener");
  });
});

test("raw HTML in agent output is not rendered as elements", async () => {
  const { container } = render(Response, {
    props: { text: 'before <img src=x onerror="alert(1)"> after', streaming: false },
  });

  await waitFor(() => expect(container.textContent).toContain("before"));
  expect(container.querySelector("img")).toBeNull();
});
