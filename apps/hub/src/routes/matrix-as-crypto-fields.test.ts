/**
 * The crypto fields of an appservice transaction arrive under unstable names.
 *
 * This file exists because they did not, for the whole first version of the
 * bridge's encryption: the reader looked for `to_device` and
 * `device_one_time_keys_count`, the homeserver sent
 * `de.sorunome.msc2409.to_device` and
 * `org.matrix.msc3202.device_one_time_keys_count`, and every transaction parsed
 * cleanly into nothing. Agents encrypted outbound traffic correctly and
 * received no room keys and no key counts — reachable only by reading a real
 * transaction, which no test did.
 */
import { describe, expect, test } from "bun:test";
import { createMatrixAsRoutes, type AppserviceCryptoTransaction } from "./matrix-as";

const HS_TOKEN = "test-hs-token";

function appWith(seen: AppserviceCryptoTransaction[]) {
  return createMatrixAsRoutes({
    hsToken: HS_TOKEN,
    domain: "id.agentpod.dev",
    onEvent: async () => {},
    onCryptoTransaction: async (tx) => {
      seen.push(tx);
    },
  });
}

async function put(app: ReturnType<typeof createMatrixAsRoutes>, body: unknown) {
  return app.request(`/transactions/txn-${Math.random()}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${HS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("crypto fields on an appservice transaction", () => {
  test("the unstable names tuwunel actually sends are read", async () => {
    const seen: AppserviceCryptoTransaction[] = [];
    const res = await put(appWith(seen), {
      events: [],
      "de.sorunome.msc2409.to_device": [
        { type: "m.room.encrypted", sender: "@someone:elsewhere", content: {} },
      ],
      "org.matrix.msc3202.device_lists": { changed: ["@agent_a:id.agentpod.dev"], left: [] },
      "org.matrix.msc3202.device_one_time_keys_count": {
        "@agent_a:id.agentpod.dev": { AGENTPOD: { signed_curve25519: 42 } },
      },
      "org.matrix.msc3202.device_unused_fallback_key_types": {
        "@agent_a:id.agentpod.dev": { AGENTPOD: ["signed_curve25519"] },
      },
    });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toDevice).toHaveLength(1);
    expect(seen[0]!.deviceLists.changed).toEqual(["@agent_a:id.agentpod.dev"]);
    expect(seen[0]!.otkCounts["@agent_a:id.agentpod.dev"]?.AGENTPOD).toEqual({
      signed_curve25519: 42,
    });
    expect(
      seen[0]!.unusedFallbackKeys["@agent_a:id.agentpod.dev"]?.AGENTPOD
    ).toEqual(["signed_curve25519"]);
  });

  test("the stable names still work, for when the MSCs land", async () => {
    // The homeserver switching names must not silently empty the transaction
    // again — which is exactly how this failed the first time.
    const seen: AppserviceCryptoTransaction[] = [];
    await put(appWith(seen), {
      events: [],
      to_device: [{ type: "m.room.encrypted", sender: "@s:e", content: {} }],
      device_one_time_keys_count: {
        "@agent_a:id.agentpod.dev": { AGENTPOD: { signed_curve25519: 7 } },
      },
    });

    expect(seen[0]!.toDevice).toHaveLength(1);
    expect(seen[0]!.otkCounts["@agent_a:id.agentpod.dev"]?.AGENTPOD).toEqual({
      signed_curve25519: 7,
    });
  });

  test("a transaction with no crypto fields is empty, not undefined", async () => {
    const seen: AppserviceCryptoTransaction[] = [];
    await put(appWith(seen), { events: [] });

    expect(seen[0]!.toDevice).toEqual([]);
    expect(seen[0]!.deviceLists).toEqual({ changed: [], left: [] });
    expect(seen[0]!.otkCounts).toEqual({});
  });
});
