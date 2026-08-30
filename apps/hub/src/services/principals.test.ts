import { describe, expect, test } from "bun:test";
import { createPrincipal, principalForUser } from "./principals";

describe("principals", () => {
  test("mints an agent principal with a grammar-valid id", async () => {
    const id = await createPrincipal({ kind: "agent", handle: "writer-quill" });
    expect(id).toMatch(/^prn_[0-9a-f]{20}$/);
  });

  test("refuses a second principal on the same handle", async () => {
    await createPrincipal({ kind: "agent", handle: "analyst-echo" });
    // A handle is an address: two claimants make the mxid it produces ambiguous.
    expect(createPrincipal({ kind: "agent", handle: "analyst-echo" })).rejects.toThrow();
  });

  test("finds the principal behind a Better Auth user", async () => {
    const id = await createPrincipal({ kind: "human", handle: "rakesh", userId: "usr-uuid-here" });
    const found = await principalForUser("usr-uuid-here");
    expect(found?.id).toBe(id);
    expect(found?.kind).toBe("human");
  });

  test("a user with no principal resolves to null, never to a default", async () => {
    // Falling back would hand one principal's authority to an unmapped caller.
    expect(await principalForUser("usr-nobody")).toBeNull();
  });
});
