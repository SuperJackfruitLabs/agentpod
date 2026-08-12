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
import { handleSnapshot, handleDestroy, snapshotKey, type SnapshotDeps } from "../src/snapshot";

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

describe("handleDestroy — regression: the archive must not survive a destroy", () => {
  /**
   * Live failure, 2026-08-12: `DELETE /sandbox/:id` returned 200 and left the
   * archive in R2. destroy() sends SIGTERM, the dying container archives on its
   * way out, and that upload landed AFTER the delete — recreating the object
   * that had just been removed. Every destroyed runtime leaked paid storage.
   *
   * The fix is ordering: revoke the token first, so a late upload is refused.
   */
  function destroyHarness() {
    const order: string[] = [];
    const objects = new Map<string, string>([["snapshots/rt_a.tar.gz", "work"]]);
    let token: string | null = TOKEN_A;
    const deps = {
      revokeToken: async () => {
        order.push("revoke");
        token = null;
      },
      destroy: async () => {
        order.push("destroy");
      },
      tokenFor: async () => token,
      get: async (key: string) => (objects.has(key) ? { body: objects.get(key)! } : null),
      put: async (key: string, body: unknown) => {
        objects.set(key, await new Response(body as BodyInit).text());
      },
      delete: async (key: string) => {
        order.push("delete");
        objects.delete(key);
      },
    };
    return { deps, order, objects };
  }

  it("revokes the token BEFORE destroying, then deletes", async () => {
    const { deps, order } = destroyHarness();
    await handleDestroy("rt_a", deps);
    expect(order).toEqual(["revoke", "destroy", "delete"]);
  });

  it("REFUSES the dying container's final upload, so the delete is final", async () => {
    // The actual failure, reproduced: destroy, then the container's last gasp
    // arrives with the token it was given at create time.
    const { deps, objects } = destroyHarness();
    await handleDestroy("rt_a", deps);
    expect(objects.has("snapshots/rt_a.tar.gz")).toBe(false);

    const late = await handleSnapshot(
      "rt_a",
      "PUT",
      new Request("https://w.example/sandbox/rt_a/snapshot", {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN_A}` },
        body: "last gasp",
      }),
      deps
    );

    expect(late.status).toBe(401);
    // The whole point: the archive stays deleted.
    expect(objects.has("snapshots/rt_a.tar.gz")).toBe(false);
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
