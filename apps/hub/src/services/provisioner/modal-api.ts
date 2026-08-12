/**
 * The narrow slice of Modal this driver needs, and the one place the SDK is
 * allowed to be imported.
 *
 * The SDK is 0.x and renames parameters between minor versions — `timeout`
 * became `timeoutMs`, and an unknown key is rejected at runtime by the SDK's own
 * guard rather than ignored. Confining it to one file means a rename costs one
 * edit and one test, not an audit of the driver. It is pinned exactly
 * (`"modal": "0.9.0"`, no caret) for the same reason: a caret on an SDK that
 * renames parameters is how a working hub stops provisioning after an unrelated
 * install.
 */

import { requireCredentials, envCredentialResolver } from "./credentials";
import type { CredentialResolver } from "./credentials";

/** Everything Modal needs to start one sandbox for one AgentPod runtime. */
export interface ModalCreateSandboxParams {
  /** Modal App the sandbox is grouped under. Grouping only; carries no state. */
  appName: string;
  /** Registry reference Modal pulls. Must be linux/amd64 and carry python+pip. */
  image: string;
  /** The durable anchor: created if missing, reused by every later sandbox. */
  volumeName: string;
  /** Where the volume is mounted. The workspace, and nothing else, lives here. */
  mountPath: string;
  /** Working directory of the entrypoint command. */
  workdir: string;
  /** Entrypoint argv. The image sets no ENTRYPOINT — see Dockerfile.modal. */
  command: string[];
  /** Environment. Carries the enrolment token: NEVER log this object. */
  env: Record<string, string>;
  cpu: number;
  memoryMiB: number;
  /**
   * Maximum lifetime. Modal's default is FIVE MINUTES, so omitting it does not
   * mean "no limit", it means a station that dies before its operator returns
   * from coffee.
   */
  timeoutMs: number;
}

/**
 * A resource Modal says does not exist.
 *
 * Typed rather than message-matched: the driver has to tell "already gone,
 * which is what I wanted" from "the substrate is unreachable", and destroy
 * idempotency (conformance rule 6) hangs on getting that distinction right.
 */
export class ModalNotFoundError extends Error {}

/**
 * Credentials this substrate needs.
 *
 * Declared here rather than in modal.ts because the adapter is what consumes
 * them — `requireCredentials("modal", MODAL_CREDENTIAL_KEYS, resolver)` in
 * createModalApi() — and because the driver imports this file: a constant
 * pointing the other way would make the two modules import each other.
 *
 * Both keys, not one. Modal's tokens are a pair and requireCredentials() names
 * every missing key at once, so a hub deployed with half the pair is refused at
 * startup with one message rather than one redeploy per key.
 */
export const MODAL_CREDENTIAL_KEYS = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];

/** The substrate, as this driver needs it. `createModalApi()` is the real one. */
export interface ModalApi {
  createSandbox(params: ModalCreateSandboxParams): Promise<{ sandboxId: string }>;
  /** Irreversible. Modal has no start verb; this ends the sandbox for good. */
  terminateSandbox(sandboxId: string): Promise<void>;
  /** `null` while running, else the exit code. Throws ModalNotFoundError if forgotten. */
  pollSandbox(sandboxId: string): Promise<number | null>;
  /** Deletes the durable anchor. Throws ModalNotFoundError if already gone. */
  deleteVolume(name: string): Promise<void>;
}

/**
 * The slice of the SDK client this adapter uses, described structurally.
 *
 * Structural rather than `typeof ModalClient` on purpose: it documents exactly
 * what we depend on (five calls out of a very large surface), and it lets the
 * tests inject a stand-in without constructing a real client or reaching the
 * network. Verified against `node_modules/modal/dist/index.d.ts` at 0.9.0 —
 * where the signatures really are `apps.fromName(name, params?)`,
 * `volumes.fromName(name, params?)`, `volumes.delete(name, params?)`,
 * `images.fromRegistry(tag, secret?)` (synchronous), and
 * `sandboxes.create(app, image, params?)`.
 */
export interface ModalClientLike {
  apps: {
    fromName(name: string, params: { createIfMissing: boolean }): Promise<unknown>;
  };
  volumes: {
    fromName(name: string, params: { createIfMissing: boolean }): Promise<unknown>;
    delete(name: string): Promise<void>;
  };
  images: {
    /** Synchronous in 0.9.0 — it returns an Image, not a Promise. */
    fromRegistry(tag: string): unknown;
  };
  sandboxes: {
    create(
      app: unknown,
      image: unknown,
      params: Record<string, unknown>
    ): Promise<ModalSandboxLike>;
    fromId(sandboxId: string): Promise<ModalSandboxLike>;
  };
}

export interface ModalSandboxLike {
  readonly sandboxId: string;
  terminate(): Promise<void>;
  /** `null` while running, else the exit code. */
  poll(): Promise<number | null>;
}

export interface CreateModalApiOptions {
  resolver?: CredentialResolver;
  /**
   * Substitute for `new ModalClient(...)`. Injected by tests so no unit test
   * ever constructs the real client, reads an operator's ~/.modal.toml, or
   * reaches the network.
   */
  clientFactory?: (creds: { tokenId: string; tokenSecret: string }) => ModalClientLike;
}

/**
 * Modal reports a missing resource with an exported `NotFoundError`, whose
 * constructor sets `this.name = "NotFoundError"` (checked in 0.9.0's dist).
 *
 * Matching on that NAME rather than importing the class keeps this adapter's
 * tests free of the SDK and survives the dual CJS/ESM builds shipping two
 * distinct class objects for the same error — `instanceof` across those two is
 * false, and a destroy path that reads "already gone" as "substrate unreachable"
 * leaks a paid volume.
 */
function isNotFound(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "NotFoundError";
}

/**
 * Run `fn`, converting Modal's not-found into the port's own error and letting
 * everything else through untouched. Both halves matter: mapping too little
 * breaks destroy idempotency, and mapping too much turns an unreachable
 * substrate into a reported success.
 */
async function mappingNotFound<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isNotFound(err)) {
      throw new ModalNotFoundError((err as Error).message);
    }
    throw err;
  }
}

/**
 * Build the real Modal-backed `ModalApi`.
 *
 * Credentials are resolved HERE, at construction, so a hub configured with
 * ENABLE_MODAL_PROVISIONING=true and no tokens refuses at startup listing every
 * missing key at once — rather than accepting a provisioning request and failing
 * it with something that reads like an auth problem.
 *
 * Note what these tokens are and are not: they create NEW infrastructure in a
 * Modal workspace. They cannot reach an enrolled node — enrolment is
 * outbound-dialled and SSH runs from the operator's machine. See credentials.ts.
 *
 * SECURITY: the resolved tokens and `params.env` (which carries the enrolment
 * token) are never logged by this module. Do not add a log line that touches
 * either.
 */
export function createModalApi({
  resolver = envCredentialResolver(),
  clientFactory,
}: CreateModalApiOptions = {}): ModalApi {
  // Throws, naming every missing key, before anything below can load or
  // construct the SDK.
  const creds = requireCredentials("modal", MODAL_CREDENTIAL_KEYS, resolver);

  const build =
    clientFactory ??
    ((c: { tokenId: string; tokenSecret: string }) => {
      // The only reference to the SDK in the codebase. Required rather than
      // imported so a hub with Modal disabled never loads it — and `require`
      // works in Bun's ESM, which is what this app runs on.
      const { ModalClient } = require("modal") as {
        ModalClient: new (params: { tokenId: string; tokenSecret: string }) => unknown;
      };
      return new ModalClient(c) as ModalClientLike;
    });

  const client = build({
    // Non-null because requireCredentials threw above if either was absent or
    // empty; noUncheckedIndexedAccess cannot see that.
    tokenId: creds.MODAL_TOKEN_ID!,
    tokenSecret: creds.MODAL_TOKEN_SECRET!,
  });

  return {
    async createSandbox(params: ModalCreateSandboxParams) {
      const app = await client.apps.fromName(params.appName, { createIfMissing: true });
      // createIfMissing is the anchor mechanism: the first sandbox for a runtime
      // creates the volume, every later one re-attaches the same data by name.
      const volume = await client.volumes.fromName(params.volumeName, {
        createIfMissing: true,
      });
      const image = client.images.fromRegistry(params.image);

      const sandbox = await mappingNotFound(() =>
        client.sandboxes.create(app, image, {
          command: params.command,
          env: params.env,
          volumes: { [params.mountPath]: volume },
          workdir: params.workdir,
          cpu: params.cpu,
          memoryMiB: params.memoryMiB,
          // Modal's default is 5 minutes, so this key is load-bearing rather
          // than tidy. Deliberately no idleTimeoutMs: idle reaping is opt-in
          // and opting in would reap a busy station whose agent only ever
          // dials out.
          timeoutMs: params.timeoutMs,
        })
      );
      return { sandboxId: sandbox.sandboxId };
    },

    async terminateSandbox(sandboxId: string) {
      await mappingNotFound(async () => {
        const sandbox = await client.sandboxes.fromId(sandboxId);
        await sandbox.terminate();
      });
    },

    async pollSandbox(sandboxId: string) {
      return mappingNotFound(async () => {
        const sandbox = await client.sandboxes.fromId(sandboxId);
        return sandbox.poll();
      });
    },

    async deleteVolume(name: string) {
      await mappingNotFound(() => client.volumes.delete(name));
    },
  };
}
