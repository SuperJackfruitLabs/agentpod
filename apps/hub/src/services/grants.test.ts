import { describe, expect, test } from "bun:test";
import { grantAllowsPrincipal } from "./grants";

const grant = (ids: string[]) => ({ mayDispatch: ids, mayGrantReach: false });

describe("a grant names one principal", () => {
  test("allows exactly the principal it names", () => {
    expect(grantAllowsPrincipal(grant(["prn_0123456789abcdef0123"]), "prn_0123456789abcdef0123")).toBe(true);
  });

  test("no grant is not an unrestricted grant", () => {
    expect(grantAllowsPrincipal(null, "prn_0123456789abcdef0123")).toBe(false);
  });

  test("an unassigned station is dispatchable by nobody", () => {
    expect(grantAllowsPrincipal(grant(["prn_0123456789abcdef0123"]), null)).toBe(false);
  });

  test("ignores a value from another plane rather than denying on it", () => {
    // A claim is read by more planes over time, not fewer. Refusing an
    // unrecognised value breaks every time one is added.
    expect(grantAllowsPrincipal(grant(["tm_editors", "prn_0123456789abcdef0123"]), "prn_0123456789abcdef0123")).toBe(true);
  });

  test("there is no wildcard", () => {
    // agentpod:*/hermes matched a root station that should never have existed,
    // and hermes:* silently spanned nodes. A pattern matches things nobody
    // intended; an enumeration cannot.
    expect(grantAllowsPrincipal(grant(["*"]), "prn_0123456789abcdef0123")).toBe(false);
    expect(grantAllowsPrincipal(grant(["prn_*"]), "prn_0123456789abcdef0123")).toBe(false);
  });
});
