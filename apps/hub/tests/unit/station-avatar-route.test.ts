import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  stationAvatarRoutes,
  sniffImage,
  MATRIX_AVATAR_MAX_BYTES,
  type AvatarBridge,
  type AvatarTarget,
} from "../../src/routes/station-avatar";

/**
 * POST /api/stations/:stationId/matrix-avatar — a workspace image as the
 * station's Matrix profile picture. Harness mode goes to the node
 * (`matrix.avatar.set`); bridge mode is the appservice's own job.
 */

const OWNER = "user-owner";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

const HERMES: AvatarTarget = {
  id: "st_1",
  nodeId: "node_1",
  stationKey: "hermes:coder-kai",
  harness: "hermes",
  matrixIdentityMode: "harness",
  matrixId: "@agent_coder-kai:id.agentpod.dev",
  principalId: null,
};

const BRIDGED: AvatarTarget = {
  ...HERMES,
  id: "st_2",
  stationKey: "codex:repo",
  harness: "codex",
  matrixIdentityMode: "bridge",
  matrixId: null,
  principalId: "prn_1",
};

type Call = { nodeId: string; verb: string; params: unknown };

function setup(opts: {
  target?: AvatarTarget;
  answer?: { ok: boolean; data?: unknown; error?: string };
  bridge?: AvatarBridge | null;
} = {}) {
  const calls: Call[] = [];
  const target = opts.target ?? HERMES;
  const bridgeCalls: string[] = [];
  const bridge: AvatarBridge | undefined =
    opts.bridge === null
      ? undefined
      : (opts.bridge ?? {
          speakerFor: async () => "@agent_repo:id.agentpod.dev",
          uploadImage: async (u, b, t) => {
            bridgeCalls.push(`upload:${u}:${t}:${b.length}`);
            return "mxc://id.agentpod.dev/xyz";
          },
          setAvatar: async (u, m) => {
            bridgeCalls.push(`set:${u}:${m}`);
          },
        });
  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id: c.req.header("x-user") ?? OWNER, role: "user" } as never);
      await next();
    })
    .route(
      "/api",
      stationAvatarRoutes({
        target: async (userId, stationId) => (userId === OWNER && stationId === target.id ? target : null),
        brokerRequest: async (nodeId, verb, params) => {
          calls.push({ nodeId, verb, params });
          return opts.answer ?? { ok: true, data: { matrixId: HERMES.matrixId, mxc: "mxc://id.agentpod.dev/abc" } };
        },
        bridge,
      })
    );
  const post = (body: unknown = { path: "pfp.png" }, id = target.id, headers: Record<string, string> = {}) =>
    app.request(`/api/stations/${id}/matrix-avatar`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { post, calls, bridgeCalls };
}

describe("POST /api/stations/:id/matrix-avatar — harness mode", () => {
  test("asks the node to set it, with the key and path only", async () => {
    const { post, calls } = setup();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matrixId: HERMES.matrixId, mxc: "mxc://id.agentpod.dev/abc" });
    expect(calls).toEqual([{ nodeId: "node_1", verb: "matrix.avatar.set", params: { key: "hermes:coder-kai", path: "pfp.png" } }]);
  });

  test("someone else's station is a 404 and reaches no node", async () => {
    const { post, calls } = setup();
    const res = await post(undefined, "st_1", { "x-user": "someone-else" });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("a node's refusal comes back as a 502 carrying its reason", async () => {
    const { post } = setup({ answer: { ok: false, error: "matrix.avatar.set: \"x.txt\" is not an image" } });
    const res = await post();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("not an image");
  });

  test("an old node's answer is named for what it is", async () => {
    const { post } = setup({ answer: { ok: true, data: { something: "else" } } });
    const res = await post();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("predate matrix.avatar.set");
  });

  test("a harness with no Matrix login on the node is refused before the node is asked", async () => {
    const { post, calls } = setup({ target: { ...HERMES, harness: "openclaw" } });
    const res = await post();
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("a station with no Matrix identity is refused", async () => {
    const { post, calls } = setup({ target: { ...HERMES, matrixId: null } });
    expect((await post()).status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test("an empty path is a 400", async () => {
    const { post } = setup();
    expect((await post({ path: "" })).status).toBe(400);
  });
});

describe("POST /api/stations/:id/matrix-avatar — bridge mode", () => {
  const read = (bytes: Uint8Array, truncated = false) => ({
    ok: true,
    data: { content: Buffer.from(bytes).toString("base64"), encoding: "base64", truncated },
  });

  test("reads through the node and sets it as the appservice user", async () => {
    const { post, calls, bridgeCalls } = setup({ target: BRIDGED, answer: read(PNG) });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matrixId: "@agent_repo:id.agentpod.dev", mxc: "mxc://id.agentpod.dev/xyz" });
    expect(calls).toEqual([
      { nodeId: "node_1", verb: "fs.read", params: { key: "codex:repo", path: "pfp.png", maxBytes: MATRIX_AVATAR_MAX_BYTES } },
    ]);
    expect(bridgeCalls).toEqual([
      `upload:@agent_repo:id.agentpod.dev:image/png:${PNG.length}`,
      "set:@agent_repo:id.agentpod.dev:mxc://id.agentpod.dev/xyz",
    ]);
  });

  test("a file that is not an image is not uploaded", async () => {
    const { post, bridgeCalls } = setup({ target: BRIDGED, answer: read(new TextEncoder().encode("hello")) });
    expect((await post()).status).toBe(400);
    expect(bridgeCalls).toHaveLength(0);
  });

  test("a truncated image is not uploaded", async () => {
    const { post, bridgeCalls } = setup({ target: BRIDGED, answer: read(PNG, true) });
    expect((await post()).status).toBe(413);
    expect(bridgeCalls).toHaveLength(0);
  });

  test("no bridge configured is a 503, not a crash", async () => {
    const { post } = setup({ target: BRIDGED, bridge: null });
    expect((await post()).status).toBe(503);
  });
});

describe("sniffImage", () => {
  test("knows the four avatar types by their first bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("MATRIX_ACCESS_TOKEN=x"))).toBeNull();
  });
});
