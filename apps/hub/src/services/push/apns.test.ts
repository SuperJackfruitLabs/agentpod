import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import {
  APNS_HOSTS,
  ApnsTokenProvider,
  TOKEN_MIN_INTERVAL_MS,
  TOKEN_REFRESH_MS,
  createApnsClient,
  type ApnsTransport,
  type ApnsWireResponse,
} from "./apns";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const TOKEN = "a".repeat(64);

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("the provider token", () => {
  test("is an ES256 JWT with kid and iss, and verifies against the key", () => {
    const t = new ApnsTokenProvider(PEM, "8R6R2N4MM8", "N2QQPW2BRJ", () => 1_790_000_000_000);
    const [h, c, s] = t.token().split(".");
    expect(decode(h!)).toEqual({ alg: "ES256", kid: "8R6R2N4MM8" });
    expect(decode(c!)).toEqual({ iss: "N2QQPW2BRJ", iat: 1_790_000_000 });
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(s!, "base64url")
    );
    expect(ok).toBe(true);
  });

  test("is cached, and re-signed only after 50 minutes", () => {
    let now = 1_790_000_000_000;
    const t = new ApnsTokenProvider(PEM, "K", "T", () => now);
    const first = t.token();
    now += TOKEN_REFRESH_MS - 1;
    expect(t.token()).toBe(first);
    expect(t.signed).toBe(1);
    now += 1;
    expect(t.token()).not.toBe(first);
    expect(t.signed).toBe(2);
  });

  test("an expiry report re-signs, but never sooner than 20 minutes after the last", () => {
    let now = 1_790_000_000_000;
    const t = new ApnsTokenProvider(PEM, "K", "T", () => now);
    const first = t.token();
    t.invalidate();
    now += TOKEN_MIN_INTERVAL_MS - 1;
    expect(t.token()).toBe(first);
    now += 1;
    expect(t.token()).not.toBe(first);
    expect(t.signed).toBe(2);
  });
});

function scripted(responses: Array<ApnsWireResponse | Error>) {
  const calls: Array<{ origin: string; path: string; headers: Record<string, string>; body: string }> = [];
  const transport: ApnsTransport = async (origin, path, headers, body) => {
    calls.push({ origin, path, headers, body });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, transport };
}

const ok = (): ApnsWireResponse => ({ status: 200, body: "", headers: { "apns-id": "id-1" } });
const res = (status: number, reason?: string, headers: Record<string, string> = {}): ApnsWireResponse => ({
  status,
  body: reason ? JSON.stringify({ reason }) : "",
  headers,
});

function client(transport: ApnsTransport) {
  const tokens = new ApnsTokenProvider(PEM, "K", "T");
  return {
    tokens,
    apns: createApnsClient({ tokens, topic: "dev.supermessage.ios", transport, sleep: async () => {} }),
  };
}

const input = {
  environment: "production" as const,
  deviceToken: TOKEN,
  priority: 10 as const,
  collapseId: "$ev",
  expiration: 123,
  payload: { aps: {} },
};

describe("sending", () => {
  test("goes to the environment's host with the headers APNs requires", async () => {
    const { calls, transport } = scripted([ok(), ok()]);
    const { apns } = client(transport);
    expect(await apns.send(input)).toEqual({ status: "sent", apnsId: "id-1" });
    await apns.send({ ...input, environment: "sandbox", priority: 5, collapseId: undefined });

    expect(calls[0]!.origin).toBe(APNS_HOSTS.production);
    expect(calls[0]!.origin).toBe("https://api.push.apple.com");
    expect(calls[1]!.origin).toBe("https://api.sandbox.push.apple.com");
    expect(calls[0]!.path).toBe(`/3/device/${TOKEN}`);
    expect(calls[0]!.headers).toMatchObject({
      "apns-topic": "dev.supermessage.ios",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": "$ev",
      "apns-expiration": "123",
    });
    expect(calls[0]!.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(calls[1]!.headers["apns-priority"]).toBe("5");
    expect(calls[1]!.headers["apns-collapse-id"]).toBeUndefined();
  });

  test("reuses one token across pushes", async () => {
    const { calls, transport } = scripted([ok(), ok(), ok()]);
    const { apns, tokens } = client(transport);
    await apns.send(input);
    await apns.send(input);
    await apns.send(input);
    expect(new Set(calls.map((c) => c.headers.authorization)).size).toBe(1);
    expect(tokens.signed).toBe(1);
  });
});

describe("which answers mean the device is gone", () => {
  test.each([
    [410, "Unregistered"],
    [410, undefined],
    [400, "BadDeviceToken"],
    [400, "DeviceTokenNotForTopic"],
    [400, "Unregistered"],
  ])("%d %s → rejected", async (status, reason) => {
    const { transport } = scripted([res(status, reason)]);
    expect((await client(transport).apns.send(input)).status).toBe("rejected");
  });

  test.each([
    [400, "BadCollapseId"],
    [400, "PayloadTooLarge"],
    [403, "InvalidProviderToken"],
    [413, "PayloadTooLarge"],
  ])("%d %s → failed, not rejected, and not retried", async (status, reason) => {
    const { calls, transport } = scripted([res(status, reason), ok()]);
    expect(await client(transport).apns.send(input)).toEqual({ status: "failed", reason });
    expect(calls).toHaveLength(1);
  });
});

describe("retries", () => {
  test("5xx and 429 are retried, boundedly", async () => {
    const { calls, transport } = scripted([res(503, "ServiceUnavailable"), res(429, "TooManyRequests"), ok()]);
    expect((await client(transport).apns.send(input)).status).toBe("sent");
    expect(calls).toHaveLength(3);

    const always = scripted([res(500, "InternalServerError"), res(500), res(500), res(500), ok()]);
    expect((await client(always.transport).apns.send(input)).status).toBe("failed");
    expect(always.calls).toHaveLength(3);
  });

  test("a transport failure or timeout is retried", async () => {
    const { calls, transport } = scripted([new Error("APNs request timed out after 5000ms"), ok()]);
    expect((await client(transport).apns.send(input)).status).toBe("sent");
    expect(calls).toHaveLength(2);
  });

  test("an expired provider token is re-signed once and the push retried", async () => {
    const { calls, transport } = scripted([res(403, "ExpiredProviderToken"), ok()]);
    const tokens = new ApnsTokenProvider(PEM, "K", "T", () => Date.now() + 0);
    const apns = createApnsClient({ tokens, topic: "t", transport, sleep: async () => {} });
    expect((await apns.send(input)).status).toBe("sent");
    expect(calls).toHaveLength(2);
  });
});
