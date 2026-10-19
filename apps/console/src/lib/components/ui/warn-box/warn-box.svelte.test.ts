import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { WarnBox } from "./index";

afterEach(() => cleanup());

const body = createRawSnippet(() => ({ render: () => "<p>Native placement is off</p>" }));

test("the warning box draws with the warn tokens, never the Tailwind palette", () => {
  const { container } = render(WarnBox, { props: { children: body } });
  const box = container.querySelector("[data-slot='warn-box']")!;
  expect(box.textContent).toContain("Native placement is off");
  expect(box.className).toMatch(/border-warn/);
  expect(box.className).toMatch(/bg-warn-wash/);
  expect(box.className).not.toMatch(/amber|yellow|orange/);
});

test("it passes role, test id and extra classes through", () => {
  const { getByRole } = render(WarnBox, {
    props: { children: body, role: "alert", "data-testid": "unassigned-stations", class: "flex gap-3" },
  });
  const box = getByRole("alert");
  expect(box.getAttribute("data-testid")).toBe("unassigned-stations");
  expect(box.className).toMatch(/flex gap-3/);
});
