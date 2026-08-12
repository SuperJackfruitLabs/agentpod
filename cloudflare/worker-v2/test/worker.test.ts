import { describe, it, expect } from "vitest";
import { isAuthorised } from "../src/auth";

const req = (token?: string) =>
  new Request("https://w.example/sandbox", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe("isAuthorised", () => {
  it("refuses everything when no secret is configured", () => {
    // A worker deployed without its secret must not be open. Failing closed
    // matters more here than anywhere: this endpoint starts containers that
    // enrol into the fleet.
    expect(isAuthorised(req("anything"), undefined)).toBe(false);
    expect(isAuthorised(req("anything"), "")).toBe(false);
  });

  it("accepts the right token and rejects a wrong one", () => {
    expect(isAuthorised(req("s3cret"), "s3cret")).toBe(true);
    expect(isAuthorised(req("wrong!"), "s3cret")).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(isAuthorised(req(), "s3cret")).toBe(false);
    expect(
      isAuthorised(
        new Request("https://w.example/sandbox", {
          headers: { Authorization: "s3cret" },
        }),
        "s3cret"
      )
    ).toBe(false);
  });

  it("rejects a token of a different length without comparing content", () => {
    expect(isAuthorised(req("s3cre"), "s3cret")).toBe(false);
    expect(isAuthorised(req("s3crett"), "s3cret")).toBe(false);
  });
});
