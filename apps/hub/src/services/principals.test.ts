/**
 * Service Test: principals, read from and (for agents) created at the organization plane.
 *
 * The run's fake plane (`tests/helpers/fake-plane.ts`) stands behind the real client and
 * directory seams, so these go through the production functions end to end.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test } from "bun:test";
import {
  createPrincipal,
  humanPrincipalIdForUser,
  listPrincipals,
  principalById,
  principalForUser,
  principalHandle,
  SUSPENDED_AT_UNKNOWN,
} from "./principals";
import { fakePlane } from "../../tests/helpers/fake-plane";

const RUN = crypto.randomUUID().slice(0, 8);

describe("principals", () => {
  test("mints an agent principal at the plane, with a grammar-valid id", async () => {
    const id = await createPrincipal({ kind: "agent", handle: `writer-quill-${RUN}` });
    expect(id).toMatch(/^prn_[0-9a-f]{20}$/);
    expect(fakePlane.principals.get(id)?.kind).toBe("agent");
  });

  test("refuses a second principal on the same handle (the plane's 409)", async () => {
    await createPrincipal({ kind: "agent", handle: `analyst-echo-${RUN}` });
    // A handle is an address: two claimants make the mxid it produces ambiguous.
    await expect(createPrincipal({ kind: "agent", handle: `analyst-echo-${RUN}` })).rejects.toThrow();
  });

  test("humans and services are made at the plane, never by the hub", async () => {
    await expect(createPrincipal({ kind: "human", handle: `h-${RUN}` })).rejects.toThrow(/org plane/);
    await expect(createPrincipal({ kind: "service", handle: `s-${RUN}` })).rejects.toThrow(/org plane/);
  });

  test("an account id IS the human's principal (contract §2)", async () => {
    const id = fakePlane.addHuman({ handle: `rakesh-${RUN}` });
    const found = await principalForUser(id);
    expect(found?.id).toBe(id);
    expect(found?.kind).toBe("human");
    expect(await humanPrincipalIdForUser(id)).toBe(id);
  });

  test("a user with no principal resolves to null, never to a default", async () => {
    // Falling back would hand one principal's authority to an unmapped caller.
    expect(await principalForUser("prn_ffffffffffffffffffff")).toBeNull();
    expect(await humanPrincipalIdForUser("not-a-principal-id")).toBeNull();
  });

  test("an agent is not a user", async () => {
    const id = await createPrincipal({ kind: "agent", handle: `agent-not-user-${RUN}` });
    expect(await principalForUser(id)).toBeNull();
    expect((await principalById(id))?.kind).toBe("agent");
  });

  test("no email: the plane's principal reads carry none and nothing in the hub needs one", async () => {
    const id = fakePlane.addHuman({ handle: `mail-${RUN}` });
    const p = await principalById(id);
    expect(p?.email).toBeNull();
    expect(p?.emailVerified).toBeNull();
  });

  test("a suspended principal reads as suspended, and a handle as its handle", async () => {
    const id = await createPrincipal({ kind: "agent", handle: `susp-${RUN}` });
    await fakePlane.suspend(id);
    expect((await principalById(id))?.suspendedAt).toBe(SUSPENDED_AT_UNKNOWN);
    expect(await principalHandle(id)).toBe(`susp-${RUN}`);
    expect((await listPrincipals()).find((p) => p.id === id)?.suspendedAt).toBe(SUSPENDED_AT_UNKNOWN);
  });

  test("the list names a human's account id, and none for an agent", async () => {
    const human = fakePlane.addHuman({ handle: `list-h-${RUN}` });
    const agent = await createPrincipal({ kind: "agent", handle: `list-a-${RUN}` });
    const all = await listPrincipals();
    expect(all.find((p) => p.id === human)?.userId).toBe(human);
    expect(all.find((p) => p.id === agent)?.userId).toBeNull();
  });
});
