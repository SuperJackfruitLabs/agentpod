import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import Field from "./field.svelte";

const control = createRawSnippet(() => ({ render: () => `<input id="name" />` }));

describe("Field", () => {
  it("renders label and description when no error", () => {
    render(Field, {
      label: "Node name",
      description: "Shown in the fleet list.",
      for: "name",
      children: control,
    });
    expect(screen.getByText("Node name")).toBeTruthy();
    expect(screen.getByText("Shown in the fleet list.")).toBeTruthy();
  });

  it("renders label and error, hiding description", () => {
    render(Field, {
      label: "Node name",
      description: "Shown in the fleet list.",
      error: "Name is required",
      for: "name",
      children: control,
    });
    expect(screen.getByText("Node name")).toBeTruthy();
    expect(screen.getByText("Name is required")).toBeTruthy();
  });
});
