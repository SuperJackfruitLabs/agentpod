/**
 * Unit tests: the Modal SDK adapter.
 *
 * The real `modal` package is never constructed here — `clientFactory` injects a
 * structural stand-in, and the one test that omits a factory is the one that
 * must throw before a client is ever built. What is under test is exactly the
 * part that breaks when the SDK churns: which parameter names we pass, which
 * handles we thread into `sandboxes.create`, and how a Modal `NotFoundError`
 * becomes something the driver above can act on.
 *
 * The fake is deliberately unforgiving: it throws for an unknown sandbox id and
 * for deleting a volume that was never created. A fake that answers everything
 * makes every behavioural rule pass for free, which is the same as not having
 * the rule.
 */

import { describe, it, expect } from "bun:test";
import { createModalApi, ModalNotFoundError } from "./modal-api";
import type { ModalClientLike, ModalSandboxLike } from "./modal-api";

const CREDS = { MODAL_TOKEN_ID: "tok-id", MODAL_TOKEN_SECRET: "tok-secret" };
const resolverOf = (env: Record<string, string>) => ({ get: (k: string) => env[k] });

/**
 * A NotFoundError shaped like the SDK's: `name` set to "NotFoundError", a plain
 * Error otherwise. Verified against modal@0.9.0's dist, where the class
 * constructor assigns `this.name = "NotFoundError"` — so matching on the name
 * rather than the class is a real match, not a hopeful one.
 */
class FakeNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

interface CreateCall {
  app: unknown;
  image: unknown;
  params: Record<string, unknown>;
}

/**
 * @param seed.volumes volumes that already exist in the fake workspace; anything
 *   else is "already gone" to `volumes.delete`.
 */
function fakeClient(seed: { volumes?: string[] } = {}) {
  const calls = {
    apps: [] as Array<[string, unknown]>,
    volumes: [] as Array<[string, unknown]>,
    deleted: [] as string[],
    images: [] as string[],
    created: [] as CreateCall[],
    terminated: [] as string[],
  };

  const existingVolumes = new Set<string>(seed.volumes ?? []);
  // Handles are memoised per name so a test can assert that the object threaded
  // into sandboxes.create is the one fromName/fromRegistry actually returned —
  // an adapter that swapped the app and image arguments would slip past an
  // assertion that only looked at the params bag.
  const appHandles = new Map<string, { appId: string }>();
  const volumeHandles = new Map<string, { volumeId: string }>();

  const sandboxes = new Map<string, ModalSandboxLike>();
  const makeSandbox = (id: string, exitCode: number | null = null): ModalSandboxLike => ({
    sandboxId: id,
    async terminate() {
      calls.terminated.push(id);
    },
    async poll() {
      return exitCode;
    },
  });

  const client: ModalClientLike = {
    apps: {
      async fromName(name, params) {
        calls.apps.push([name, params]);
        let handle = appHandles.get(name);
        if (!handle) {
          handle = { appId: `ap-${name}` };
          appHandles.set(name, handle);
        }
        return handle;
      },
    },
    volumes: {
      async fromName(name, params) {
        calls.volumes.push([name, params]);
        if (params.createIfMissing) existingVolumes.add(name);
        if (!existingVolumes.has(name)) {
          throw new FakeNotFound(`Volume '${name}' not found`);
        }
        let handle = volumeHandles.get(name);
        if (!handle) {
          handle = { volumeId: `vo-${name}` };
          volumeHandles.set(name, handle);
        }
        return handle;
      },
      async delete(name) {
        if (!existingVolumes.delete(name)) {
          throw new FakeNotFound(`Volume '${name}' not found`);
        }
        calls.deleted.push(name);
      },
    },
    images: {
      fromRegistry(tag) {
        calls.images.push(tag);
        return { imageId: `im-${tag}` };
      },
    },
    sandboxes: {
      async create(app, image, params) {
        calls.created.push({ app, image, params });
        const sandbox = makeSandbox("sb-created");
        sandboxes.set(sandbox.sandboxId, sandbox);
        return sandbox;
      },
      async fromId(id) {
        const sandbox = sandboxes.get(id);
        if (!sandbox) throw new FakeNotFound(`Sandbox '${id}' not found`);
        return sandbox;
      },
    },
  };

  return { client, calls, sandboxes, makeSandbox };
}

const apiWith = (client: ModalClientLike) =>
  createModalApi({ resolver: resolverOf(CREDS), clientFactory: () => client });

/**
 * A client factory that must never run.
 *
 * Every credential-refusal test passes one. Without it a regression in the
 * guard would fall through to `require("modal")` and construct a real
 * ModalClient against whatever ~/.modal.toml the machine happens to have — the
 * test might even still pass, for entirely the wrong reason. Measured: with
 * requireCredentials removed, that path really is taken.
 */
const neverBuilt = (): never => {
  throw new Error("clientFactory must not run without credentials");
};

const SANDBOX_SPEC = {
  appName: "agentpod",
  image: "ghcr.io/example/agentpod-node-modal:v1",
  volumeName: "agentpod-rt-abc",
  mountPath: "/workspace",
  workdir: "/workspace",
  command: ["/modal-entrypoint.sh"],
  env: { AGENTPOD_HUB_URL: "https://hub.example", AGENTPOD_ENROLL_TOKEN: "tok" },
  cpu: 1,
  memoryMiB: 2048,
  timeoutMs: 86_400_000,
};

describe("createModalApi — credentials", () => {
  it("refuses to build without credentials, naming every missing key at once", () => {
    // A startup refusal, not a runtime failure on a user's first provision —
    // and one that costs an operator one redeploy rather than one per key.
    expect(() =>
      createModalApi({ resolver: resolverOf({}), clientFactory: neverBuilt })
    ).toThrow(/MODAL_TOKEN_ID.*MODAL_TOKEN_SECRET/);
  });

  it("refuses a half-configured hub, naming only the key that is missing", () => {
    // The failure mode this guards: a deploy that set the id and forgot the
    // secret gets an error it can act on, not "credentials are wrong".
    const half = () =>
      createModalApi({
        resolver: resolverOf({ MODAL_TOKEN_ID: "tok-id" }),
        clientFactory: neverBuilt,
      });
    expect(half).toThrow(/MODAL_TOKEN_SECRET/);
    const err = (() => {
      try {
        half();
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("MODAL_TOKEN_ID");
    expect(err!.message).toContain("modal");
  });

  it("treats an empty token as missing rather than handing the SDK a blank", () => {
    // Deploy platforms surface an unset secret as "", and a blank token only
    // moves the failure to the first API call, where it reads as an auth
    // problem rather than a configuration one.
    expect(() =>
      createModalApi({
        resolver: resolverOf({ MODAL_TOKEN_ID: "tok-id", MODAL_TOKEN_SECRET: "" }),
        clientFactory: neverBuilt,
      })
    ).toThrow(/MODAL_TOKEN_SECRET/);
  });

  it("passes the resolved tokens to the client", () => {
    const seen: Array<{ tokenId: string; tokenSecret: string }> = [];
    const { client } = fakeClient();
    createModalApi({
      resolver: resolverOf(CREDS),
      clientFactory: (c) => {
        seen.push(c);
        return client;
      },
    });
    expect(seen).toEqual([{ tokenId: "tok-id", tokenSecret: "tok-secret" }]);
  });
});

describe("createModalApi — createSandbox", () => {
  it("creates the app and the volume if missing, and mounts that volume", async () => {
    const { client, calls } = fakeClient();
    const res = await apiWith(client).createSandbox(SANDBOX_SPEC);

    expect(res.sandboxId).toBe("sb-created");
    expect(calls.apps).toEqual([["agentpod", { createIfMissing: true }]]);
    // createIfMissing on the volume is what makes provisioning idempotent on the
    // anchor: the first sandbox creates it, every later one re-attaches it.
    expect(calls.volumes).toEqual([["agentpod-rt-abc", { createIfMissing: true }]]);
    expect(calls.images).toEqual(["ghcr.io/example/agentpod-node-modal:v1"]);

    const call = calls.created[0]!;
    // The handles, not just the names: sandboxes.create(app, image, params) is
    // positional, and swapping two opaque objects is a mistake no name-level
    // assertion would notice.
    expect(call.app).toEqual({ appId: "ap-agentpod" });
    expect(call.image).toEqual({ imageId: "im-ghcr.io/example/agentpod-node-modal:v1" });

    const params = call.params;
    // Mounted at mountPath, and it is THE volume named for this runtime.
    expect(params.volumes).toEqual({ "/workspace": { volumeId: "vo-agentpod-rt-abc" } });
    expect(params.workdir).toBe("/workspace");
    expect(params.command).toEqual(["/modal-entrypoint.sh"]);
    expect(params.env).toEqual({
      AGENTPOD_HUB_URL: "https://hub.example",
      AGENTPOD_ENROLL_TOKEN: "tok",
    });
    expect(params.cpu).toBe(1);
    expect(params.memoryMiB).toBe(2048);
    // 0.9.0 renamed `timeout` to `timeoutMs` and REJECTS the old key at runtime.
    expect(params.timeoutMs).toBe(86_400_000);
    expect(params).not.toHaveProperty("timeout");
    // Never opt into idle reaping: a node-agent dials out and receives nothing,
    // so an idle timer would reap a busy station. Off by default; keep it off.
    expect(params).not.toHaveProperty("idleTimeoutMs");
  });
});

describe("createModalApi — terminateSandbox", () => {
  it("terminates the sandbox it was asked about", async () => {
    const { client, calls } = fakeClient();
    const api = apiWith(client);
    await api.createSandbox(SANDBOX_SPEC);
    await api.terminateSandbox("sb-created");
    expect(calls.terminated).toEqual(["sb-created"]);
  });

  it("reports a sandbox Modal has never heard of as ModalNotFoundError", async () => {
    const { client } = fakeClient();
    await expect(apiWith(client).terminateSandbox("sb-gone")).rejects.toBeInstanceOf(
      ModalNotFoundError
    );
  });
});

describe("createModalApi — not-found mapping", () => {
  it("turns a Modal NotFoundError into ModalNotFoundError on poll", async () => {
    const { client } = fakeClient();
    await expect(apiWith(client).pollSandbox("sb-gone")).rejects.toBeInstanceOf(
      ModalNotFoundError
    );
  });

  it("turns a Modal NotFoundError into ModalNotFoundError on volume delete", async () => {
    // destroy() has to tell "already gone, which is what I wanted" from "the
    // substrate is unreachable", and conformance rule 6 fails the driver if it
    // gets that wrong.
    const { client } = fakeClient();
    await expect(apiWith(client).deleteVolume("gone")).rejects.toBeInstanceOf(
      ModalNotFoundError
    );
  });

  it("keeps the substrate's message so an operator can see what was missing", async () => {
    const { client } = fakeClient();
    // then(resolve, reject) rather than catch(): it types the value without an
    // `any`, and it fails loudly if the call resolves instead of rejecting,
    // which .catch() would have quietly reported as "no message to check".
    const err = await apiWith(client)
      .deleteVolume("gone")
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("Volume 'gone' not found");
  });

  it("does NOT swallow an unrelated failure", async () => {
    // The other direction of the same guard: if everything became
    // ModalNotFoundError, destroy() would call an unreachable substrate a
    // successful deletion and leak a paid volume while reporting success.
    const { client } = fakeClient();
    const boom = new Error("connection reset");
    client.volumes.delete = async () => {
      throw boom;
    };
    const err = await apiWith(client)
      .deleteVolume("agentpod-rt-abc")
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(ModalNotFoundError);
    expect(err).toBe(boom);
  });

  it("deletes a volume that does exist, and says nothing", async () => {
    const { client, calls } = fakeClient({ volumes: ["agentpod-rt-abc"] });
    await apiWith(client).deleteVolume("agentpod-rt-abc");
    expect(calls.deleted).toEqual(["agentpod-rt-abc"]);
  });
});

describe("createModalApi — poll", () => {
  it("passes the exit code through untouched", async () => {
    const { client, sandboxes, makeSandbox } = fakeClient();
    const api = apiWith(client);
    await api.createSandbox(SANDBOX_SPEC);
    // null is "still running" and must never be flattened into a falsy 0 — the
    // driver's status() reads exactly this distinction.
    expect(await api.pollSandbox("sb-created")).toBeNull();
    sandboxes.set("sb-created", makeSandbox("sb-created", 137));
    expect(await api.pollSandbox("sb-created")).toBe(137);
    sandboxes.set("sb-created", makeSandbox("sb-created", 0));
    expect(await api.pollSandbox("sb-created")).toBe(0);
  });
});
