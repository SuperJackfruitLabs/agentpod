/**
 * Unit tests: the sandbox environment, split by ownership.
 *
 * The bug these exist for (#253): the environment was written to DO storage once
 * at creation and replayed verbatim on every wake, so `AGENTPOD_SNAPSHOT_URL`
 * and `AGENTPOD_SNAPSHOT_TOKEN` — added to the worker on 2026-08-12 05:53Z —
 * reached new sandboxes only. Runtime rt_aa47bc04ed34443796bc, created 72
 * minutes earlier, enrolled, heartbeated and served a terminal while
 * snapshot-wrapper.sh silently skipped both restore and archive, dropping the
 * user's workspace on every sleep, for the life of the sandbox.
 *
 * So the first test here is the healing one: a stored env that predates the
 * snapshot keys must come back from a start WITH them. Everything else is the
 * boundary — what the worker may re-derive, and what it must never touch.
 */

import { describe, it, expect } from "vitest";
import {
  ENV_KEY,
  SNAPSHOT_TOKEN_KEY,
  SUBSTRATE_OWNED_KEYS,
  callerOwned,
  createStartEnv,
  snapshotToken,
  storedStartEnv,
  type EnvStorage,
} from "../src/env";

/** In-memory stand-in for Durable Object storage. */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed));
  const storage: EnvStorage = {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      map.set(key, value);
    },
  };
  return { storage, map };
}

/** Exactly what a sandbox created before 2026-08-12 05:53Z has in storage. */
const PRE_SNAPSHOT_ENV = {
  AGENTPOD_HUB_URL: "https://hub.agentpod.dev",
  AGENTPOD_ENROLL_TOKEN: "enrol-tok",
  AGENTPOD_RUNTIME_ID: "rt_aa47bc04ed34443796bc",
  AGENTPOD_RUNTIME_CALLBACK_TOKEN: "callback-tok",
};

const ctx = {
  origin: "https://sandbox.agentpod.dev",
  sandboxId: "rt_aa47bc04ed34443796bc",
};

describe("storedStartEnv — a sandbox older than the snapshot feature heals", () => {
  it("gives a pre-snapshot stored env both snapshot keys on its next start", async () => {
    // THE regression test for #253. Before the fix this returned the stored map
    // untouched, `configured()` in snapshot-wrapper.sh was false, and the
    // container archived nothing on SIGTERM — silently, forever.
    const { storage } = fakeStorage({ [ENV_KEY]: PRE_SNAPSHOT_ENV });

    const env = await storedStartEnv(storage, ctx);

    expect(env.AGENTPOD_SNAPSHOT_URL).toBe(
      "https://sandbox.agentpod.dev/sandbox/rt_aa47bc04ed34443796bc/snapshot"
    );
    expect(env.AGENTPOD_SNAPSHOT_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints the snapshot token the sandbox never had, and keeps it", async () => {
    // The healing sandbox has no stored token either — it was minted at create
    // time, and this one was created before that code existed. The token must
    // be minted on this start and be the SAME one the snapshot routes will
    // authenticate against, or the container uploads and gets a 401.
    const { storage, map } = fakeStorage({ [ENV_KEY]: PRE_SNAPSHOT_ENV });

    const first = await storedStartEnv(storage, ctx);
    expect(first.AGENTPOD_SNAPSHOT_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(map.get(SNAPSHOT_TOKEN_KEY)).toBe(first.AGENTPOD_SNAPSHOT_TOKEN);

    // And a later wake must not rotate it: the archive in R2 is reachable only
    // with the token the sandbox holds, so a new one each start would be a
    // slow-motion version of the same data loss.
    const second = await storedStartEnv(storage, ctx);
    expect(second.AGENTPOD_SNAPSHOT_TOKEN).toBe(first.AGENTPOD_SNAPSHOT_TOKEN);
  });

  it("preserves every caller-owned value verbatim", async () => {
    // The worker cannot re-derive these: the enrolment and callback tokens were
    // minted by the hub at create time and exist nowhere else. Dropping one
    // gives a container that cannot enrol and is restarted forever.
    const { storage } = fakeStorage({ [ENV_KEY]: PRE_SNAPSHOT_ENV });

    const env = await storedStartEnv(storage, ctx);

    expect(env).toMatchObject(PRE_SNAPSHOT_ENV);
  });

  it("refuses to start a sandbox that was never created", async () => {
    // A container booted with no hub URL cannot enrol, exits under `set -e`,
    // and is restarted forever — silently, and it bills. A failed request is
    // strictly better.
    const { storage } = fakeStorage();
    await expect(storedStartEnv(storage, ctx)).rejects.toThrow(
      /no stored environment/
    );
  });
});

describe("storedStartEnv — substrate-owned values are re-derived, never replayed", () => {
  it("overrides a stale stored snapshot URL with one derived from this request", async () => {
    // Belt and braces for the class of bug, not just its one instance: even a
    // sandbox whose stored map DOES carry a snapshot URL gets the current one,
    // so moving the worker to another hostname does not strand every existing
    // sandbox pointing at the old one.
    const { storage } = fakeStorage({
      [ENV_KEY]: {
        ...PRE_SNAPSHOT_ENV,
        AGENTPOD_SNAPSHOT_URL: "https://old-worker.workers.dev/sandbox/rt_x/snapshot",
      },
    });

    const env = await storedStartEnv(storage, ctx);

    expect(env.AGENTPOD_SNAPSHOT_URL).toBe(
      "https://sandbox.agentpod.dev/sandbox/rt_aa47bc04ed34443796bc/snapshot"
    );
  });

  it("never writes a substrate-owned value into storage", async () => {
    // Storage holds only what the worker cannot recompute. A substrate value
    // that gets persisted is a frozen value waiting to happen — which is the
    // whole of #253.
    const { storage, map } = fakeStorage();

    await createStartEnv(storage, ctx, {
      ...PRE_SNAPSHOT_ENV,
      // A caller (or an older worker) handing us one must not make it stick.
      AGENTPOD_SNAPSHOT_URL: "https://old-worker.workers.dev/sandbox/rt_x/snapshot",
    });

    const stored = map.get(ENV_KEY) as Record<string, string>;
    for (const key of SUBSTRATE_OWNED_KEYS) {
      expect(stored).not.toHaveProperty(key);
    }
    expect(stored).toEqual(PRE_SNAPSHOT_ENV);
  });
});

describe("createStartEnv", () => {
  it("starts a new sandbox with the same env a wake would produce", async () => {
    // One derivation path for create and wake. Two would drift, and drift is
    // exactly how a key ends up reaching new sandboxes only.
    const { storage } = fakeStorage();

    const created = await createStartEnv(storage, ctx, PRE_SNAPSHOT_ENV);
    const woken = await storedStartEnv(storage, ctx);

    expect(woken).toEqual(created);
  });
});

describe("callerOwned", () => {
  it("strips substrate-owned keys and keeps the rest", () => {
    expect(
      callerOwned({
        AGENTPOD_HUB_URL: "https://hub.agentpod.dev",
        AGENTPOD_SNAPSHOT_TOKEN: "stale",
        AGENTPOD_SNAPSHOT_URL: "stale",
      })
    ).toEqual({ AGENTPOD_HUB_URL: "https://hub.agentpod.dev" });
  });
});

describe("snapshotToken", () => {
  it("mints once and returns the same token afterwards", async () => {
    const { storage } = fakeStorage();
    const first = await snapshotToken(storage);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await snapshotToken(storage)).toBe(first);
  });
});
