/**
 * Unit tests: workspace snapshot routes.
 *
 * These carry the security properties of the whole persistence design. A
 * container holds a snapshot token, and that token must buy it exactly two
 * things — read and write of ITS OWN archive — and nothing else. The tests for
 * what the token cannot do come first, because those are the ones that matter
 * if this code is ever changed by someone in a hurry.
 */

import { describe, it, expect } from "vitest";
import { handleSnapshot, snapshotKey, type SnapshotDeps } from "../src/snapshot";

const TOKEN_A = "tok-sandbox-a-0000000000000000";
const TOKEN_B = "tok-sandbox-b-1111111111111111";

/** In-memory stand-in for the R2 bucket plus DO-held per-sandbox tokens. */
function fakeDeps(seed: Record<string, string> = {}) {
  const objects = new Map<string, string>(Object.entries(seed));
  const tokens: Record<string, string> = { rt_a: TOKEN_A, rt_b: TOKEN_B };
  const deps: SnapshotDeps = {
    tokenFor: async (id) => tokens[id] ?? null,
    get: async (key) => (objects.has(key) ? { body: objects.get(key)! } : null),
    // R2 accepts a ReadableStream, and streaming is deliberate here — a large
    // workspace tarball must never be buffered into worker memory. The fake
    // therefore has to consume the stream the way R2 would.
    put: async (key, body) => {
      objects.set(key, await new Response(body as BodyInit).text());
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
  return { deps, objects };
}

const req = (token: string | undefined, method: string, body?: string) =>
  new Request("https://w.example/sandbox/rt_a/snapshot", {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { body } : {}),
  });

describe("snapshotKey", () => {
  it("namespaces archives per sandbox", () => {
    expect(snapshotKey("rt_a")).toBe("snapshots/rt_a.tar.gz");
  });
});

describe("handleSnapshot — what a container token must NOT buy", () => {
  it("REFUSES one sandbox's token used against another sandbox", async () => {
    // The whole point of a per-sandbox token. If this ever passes, every
    // station on the substrate can read every other station's workspace.
    const { deps } = fakeDeps({ "snapshots/rt_b.tar.gz": "b-secret-work" });
    const res = await handleSnapshot(
      "rt_b",
      "GET",
      new Request("https://w.example/sandbox/rt_b/snapshot", {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      }),
      deps
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("b-secret-work");
  });

  it("refuses a request with no token", async () => {
    const { deps } = fakeDeps();
    const res = await handleSnapshot("rt_a", "GET", req(undefined, "GET"), deps);
    expect(res.status).toBe(401);
  });

  it("refuses a sandbox that has no stored token", async () => {
    // An unknown or destroyed sandbox must not accept uploads — otherwise a
    // stale container could keep writing to R2 forever.
    const { deps } = fakeDeps();
    const res = await handleSnapshot(
      "rt_unknown",
      "PUT",
      new Request("https://w.example/sandbox/rt_unknown/snapshot", {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN_A}` },
        body: "x",
      }),
      deps
    );
    expect(res.status).toBe(401);
  });

  it("refuses any verb other than GET and PUT", async () => {
    // Deliberately narrow: a container must not be able to delete its own
    // snapshot, or a compromised harness could erase the user's work.
    const { deps } = fakeDeps({ "snapshots/rt_a.tar.gz": "work" });
    const res = await handleSnapshot("rt_a", "DELETE", req(TOKEN_A, "DELETE"), deps);
    expect(res.status).toBe(405);
  });
});

describe("handleSnapshot — round trip", () => {
  it("stores an uploaded archive under the sandbox's key", async () => {
    const { deps, objects } = fakeDeps();
    const res = await handleSnapshot("rt_a", "PUT", req(TOKEN_A, "PUT", "tarball"), deps);
    expect(res.status).toBe(200);
    expect(objects.get("snapshots/rt_a.tar.gz")).toBe("tarball");
  });

  it("returns a stored archive", async () => {
    const { deps } = fakeDeps({ "snapshots/rt_a.tar.gz": "tarball" });
    const res = await handleSnapshot("rt_a", "GET", req(TOKEN_A, "GET"), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("tarball");
  });

  it("404s when there is no archive yet", async () => {
    // First boot. Normal, not an error — the entrypoint must be able to tell
    // "nothing saved yet" from "something went wrong" without guessing.
    const { deps } = fakeDeps();
    const res = await handleSnapshot("rt_a", "GET", req(TOKEN_A, "GET"), deps);
    expect(res.status).toBe(404);
  });
});
