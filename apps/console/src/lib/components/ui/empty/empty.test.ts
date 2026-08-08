import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import Empty from "./empty.svelte";

describe("Empty", () => {
  it("renders title and description", () => {
    render(Empty, { title: "No agents yet", description: "Connect a node to get started." });
    expect(screen.getByText("No agents yet")).toBeTruthy();
    expect(screen.getByText("Connect a node to get started.")).toBeTruthy();
  });
});
