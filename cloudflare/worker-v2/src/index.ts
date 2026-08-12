import { Container, getContainer } from "@cloudflare/containers";
import { isAuthorised } from "./auth";
import { handleSnapshot, handleDestroy, type SnapshotDeps } from "./snapshot";
import {
  SNAPSHOT_TOKEN_KEY,
  createStartEnv,
  storedStartEnv,
  type SubstrateContext,
} from "./env";
import {
  deriveState,
  handleStatus,
  STATE_KEY,
  type ContainerState,
  type LifecycleRecord,
} from "./state";

interface Env {
  // Typed with the container class so getContainer returns a stub carrying its
  // lifecycle methods — an untyped namespace would need casts at every call
  // site, and a cast is where a wrong method name survives to runtime.
  NODE_AGENT: DurableObjectNamespace<NodeAgentContainer>;
  AGENTPOD_WORKER_TOKEN?: string;
  // Workspace archives. Cloudflare container disk is ephemeral, so this is the
  // only thing standing between a sleep and the user losing their work.
  SNAPSHOTS: R2Bucket;
}

/**
 * A station on Cloudflare: a container running agentpod-node, which dials the
 * hub OUTBOUND over WSS and receives no incoming requests at all.
 *
 * That asymmetry drives the whole design. Cloudflare's activity timer is fed by
 * *incoming* requests (cloudflare/containers#147), so a node-agent generates no
 * activity however busy it is — the container will always idle out eventually.
 */
export class NodeAgentContainer extends Container {
  // Long enough that a pause in a conversation does not cost a wake, short
  // enough that an abandoned station stops billing within the hour.
  sleepAfter = "15m";

  override async onStart() {
    console.log("[agentpod] container started", new Date().toISOString());
    await this.record({ state: "running", at: new Date().toISOString() });
  }

  /**
   * Persist a lifecycle transition.
   *
   * A fallback for containerState(), not its primary source — but a durable one, and
   * the only thing left if a DO is asked about a container binding it no longer
   * has. Never allowed to throw into a lifecycle hook: failing to write a note
   * about a container stopping must not stop the container from stopping.
   */
  private async record(entry: LifecycleRecord): Promise<void> {
    try {
      await this.ctx.storage.put(STATE_KEY, entry);
    } catch (e) {
      console.log("[agentpod] could not record lifecycle state", String(e));
    }
  }

  /**
   * Is this sandbox's container actually running?
   *
   * The hub asks before it will write `stopped` for a runtime, because on this
   * substrate a stop request returning means only that the container was
   * signalled — the exit lands later, after the workspace has been archived on
   * SIGTERM. Reported from `ctx.container.running`, the runtime's own view,
   * with the recorded transition as a fallback and `unknown` when there is
   * neither. Never a guess: see src/state.ts.
   *
   * Named `containerState` rather than `state` because the base Container class
   * already has a private `state` — an override would compile as a clash and,
   * worse, shadow something it does not understand.
   */
  async containerState(): Promise<ContainerState> {
    let recorded: unknown;
    try {
      recorded = await this.ctx.storage.get(STATE_KEY);
    } catch {
      recorded = undefined;
    }
    return deriveState(this.ctx.container?.running, recorded);
  }

  /**
   * Start a NEW sandbox: persist the caller-owned environment, then start with
   * it plus the substrate-owned variables derived for this request.
   *
   * The caller-owned half MUST be stored, not merely passed to start(): a
   * container's environment does not survive a stop, and a woken container with
   * no AGENTPOD_HUB_URL or AGENTPOD_ENROLL_TOKEN fails `agentpod-node enroll`,
   * exits under `set -e`, and is restarted forever. That produced 7 live
   * instances in a silent restart loop the first time this was deployed.
   *
   * The substrate-owned half is deliberately NOT stored — see src/env.ts.
   */
  async createWithEnv(
    envVars: Record<string, string>,
    ctx: SubstrateContext
  ): Promise<void> {
    this.envVars = await createStartEnv(this.ctx.storage, ctx, envVars);
    await this.start();
  }

  /**
   * Read the per-sandbox snapshot token without minting one, for authenticating
   * a container's request.
   *
   * Minting happens on the start paths only (src/env.ts), so a request naming
   * an unknown or destroyed sandbox cannot bring a token into existence.
   * Deliberately NOT the worker admin token: a container holding that could
   * create and destroy sandboxes across the whole fleet.
   */
  async storedSnapshotToken(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(SNAPSHOT_TOKEN_KEY)) ?? null;
  }

  /**
   * Revoke the snapshot token so no further upload is accepted.
   *
   * Called BEFORE destroy, and the ordering is the whole point. destroy() sends
   * SIGTERM, which makes the container archive its workspace on the way out — so
   * deleting the R2 object first and destroying second loses the race, and the
   * dying container recreates the archive we just deleted. Observed live on
   * 2026-08-12: a destroy returned 200 and left the archive behind.
   */
  async revokeSnapshotToken(): Promise<void> {
    await this.ctx.storage.delete(SNAPSHOT_TOKEN_KEY);
  }

  /**
   * Push the idle deadline out. Called when the hub routes a verb to this
   * station, because Cloudflare's activity timer counts only INCOMING requests
   * and a node-agent dials out — so without this a station sleeps 15 minutes
   * after start however hard it is being used, which is precisely how a live
   * station vanished mid-session on 2026-08-12.
   */
  async touch(): Promise<void> {
    this.renewActivityTimeout();
  }

  /**
   * Wake: start again with the stored caller-owned environment, MERGED with
   * substrate-owned variables derived afresh for this request.
   *
   * The merge is the fix for #253. Replaying the stored map verbatim froze the
   * environment at creation, so a sandbox created before the snapshot feature
   * shipped could never learn about it and dropped its workspace on every
   * sleep, silently, forever. Deriving instead of replaying means a
   * worker-side change reaches EXISTING sandboxes on their next start.
   *
   * Throws when nothing was stored rather than starting a container that cannot
   * enrol — a restart loop is far worse than a failed request, because it is
   * silent and it bills.
   */
  async wake(ctx: SubstrateContext): Promise<void> {
    this.envVars = await storedStartEnv(this.ctx.storage, ctx);
    await this.start();
  }

  override async onStop({ exitCode, reason }: { exitCode: number; reason: string }) {
    console.log("[agentpod] container stopped", { exitCode, reason });
    // The moment a stop becomes a fact. The hub will not write `stopped` for
    // this runtime until it can read something like this back.
    await this.record({
      state: "stopped",
      at: new Date().toISOString(),
      exitCode,
      reason,
    });
  }

  /**
   * Sleep when idle, and tell the hub so.
   *
   * Cloudflare stops charging once an instance sleeps, which is ~12x cheaper
   * than staying alive and is the reason this substrate is worth having. The
   * station's WSS connection drops and its node goes offline — correctly, there
   * is no connection — but the RUNTIME is `asleep`, not broken, and only this
   * worker knows the difference.
   *
   * Safe only because BOTH halves hold: a woken container resumes the same
   * nodeId (#245) *and* restores its workspace from R2 (snapshot-wrapper.sh).
   * Identity alone was not enough — with it, a woken station came back looking
   * like itself with an empty workspace, which is worse than an obvious failure.
   */
  override async onActivityExpired() {
    console.log("[agentpod] idle — sleeping");
    // stop() BEFORE notifyHub, and in that order deliberately: stop sends
    // SIGTERM, which is what makes the container archive its workspace. Telling
    // the hub "asleep" first would announce a safe state while the archive was
    // still being written. Cloudflare allows 15 minutes between SIGTERM and
    // SIGKILL, so the container has ample room to finish.
    await this.stop();
    await this.notifyHub("asleep");
  }

  /**
   * Tell the hub this runtime's lifecycle state.
   *
   * Never throws into the lifecycle: a hub that is down must not stop a
   * container from sleeping, or an unreachable hub would keep every station
   * awake and billing.
   */
  private async notifyHub(state: "asleep"): Promise<void> {
    const env = this.envVars as Record<string, string> | undefined;
    const hubUrl = env?.AGENTPOD_HUB_URL;
    const token = env?.AGENTPOD_RUNTIME_CALLBACK_TOKEN;
    const runtimeId = env?.AGENTPOD_RUNTIME_ID;
    if (!hubUrl || !token || !runtimeId) return;

    try {
      await fetch(`${hubUrl}/public/runtimes/${runtimeId}/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ state }),
      });
    } catch (e) {
      console.log("[agentpod] hub notify failed (continuing)", String(e));
    }
  }
}

interface CreateBody {
  id: string;
  hubUrl: string;
  enrollToken: string;
  /** Lets the container tell the hub when it sleeps. Without it the hub cannot
   *  tell "idled out" from "died". */
  callbackToken: string;
}

const json = (body: unknown, status = 200) =>
  Response.json(body as Record<string, unknown>, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Liveness, unauthenticated on purpose: the driver checks it to fail fast
    // on a misconfigured URL before it holds a credential.
    if (request.method === "GET" && parts[0] === "health") {
      return json({ status: "ok" });
    }

    // Snapshot routes authenticate with the PER-SANDBOX token, not the admin
    // token, so they are matched before the admin gate. This is the only
    // unauthenticated-by-admin path in the worker, and handleSnapshot fails
    // closed: an absent, wrong, or other-sandbox token is a 401, and a sandbox
    // with no stored token (unknown or destroyed) is refused outright.
    if (parts[0] === "sandbox" && parts[1] && parts[2] === "snapshot") {
      const id = parts[1];
      const stub = getContainer(env.NODE_AGENT, id);
      const deps: SnapshotDeps = {
        tokenFor: () => stub.storedSnapshotToken(),
        get: (key) => env.SNAPSHOTS.get(key),
        put: async (key, body) => {
          await env.SNAPSHOTS.put(key, body as ReadableStream);
        },
        delete: (key) => env.SNAPSHOTS.delete(key),
      };
      return handleSnapshot(id, request.method, request, deps);
    }

    if (!isAuthorised(request, env.AGENTPOD_WORKER_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }

    if (parts[0] !== "sandbox") return json({ error: "not found" }, 404);

    // POST /sandbox — start a station.
    if (request.method === "POST" && !parts[1]) {
      let body: CreateBody;
      try {
        body = (await request.json()) as CreateBody;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      if (!body.id || !body.hubUrl || !body.enrollToken || !body.callbackToken) {
        return json(
          { error: "id, hubUrl, enrollToken and callbackToken are required" },
          400
        );
      }

      const c = getContainer(env.NODE_AGENT, body.id);
      // The token is passed through but never logged, here or anywhere in this
      // worker. Do not add log statements that reference body.enrollToken.
      //
      // Only caller-owned variables are listed here. The snapshot URL and token
      // are substrate-owned and derived on every start, create included — see
      // src/env.ts. Adding one of those here would freeze it again (#253).
      await c.createWithEnv(
        {
          AGENTPOD_HUB_URL: body.hubUrl,
          AGENTPOD_ENROLL_TOKEN: body.enrollToken,
          // Read by the container class's notifyHub, not by agentpod-node.
          AGENTPOD_RUNTIME_ID: body.id,
          AGENTPOD_RUNTIME_CALLBACK_TOKEN: body.callbackToken,
        },
        { origin: url.origin, sandboxId: body.id }
      );
      return json({ sandboxId: body.id }, 201);
    }

    const id = parts[1];
    if (!id) return json({ error: "not found" }, 404);

    const container = getContainer(env.NODE_AGENT, id);

    // Whether this sandbox's container is actually running. The hub calls this
    // to confirm a stop before it tells an operator the runtime is stopped —
    // which they read as "it has stopped costing me money", so it may not be
    // said on the strength of a stop request having been accepted.
    if (request.method === "GET" && !parts[2]) {
      return handleStatus(id, { state: () => container.containerState() });
    }

    if (request.method === "DELETE" && !parts[2]) {
      // Ordering lives in handleDestroy, which is where its regression test can
      // reach it — see the 2026-08-12 live failure recorded there.
      await handleDestroy(id, {
        revokeToken: () => container.revokeSnapshotToken(),
        destroy: () => container.destroy(),
        tokenFor: () => container.storedSnapshotToken(),
        get: (key) => env.SNAPSHOTS.get(key),
        put: async (key, body) => {
          await env.SNAPSHOTS.put(key, body as ReadableStream);
        },
        delete: (key) => env.SNAPSHOTS.delete(key),
      });
      return json({ destroyed: id });
    }

    // Push the idle deadline out. The hub calls this when it routes a verb to
    // a Cloudflare-backed node, which is the only way this substrate learns
    // that a station is in use — see NodeAgentContainer.touch.
    if (request.method === "POST" && parts[2] === "touch") {
      await container.touch();
      return json({ touched: id });
    }

    // The wake path. Uses the STORED caller-owned environment — a bare start()
    // would boot a container with no hub URL or enrolment token, which cannot
    // enrol and gets restarted forever — merged with substrate-owned variables
    // derived from THIS request. The origin is taken from the request rather
    // than from storage on purpose: the sandboxes that need healing are exactly
    // the ones with nothing useful stored (#253).
    if (request.method === "POST" && parts[2] === "start") {
      try {
        await container.wake({ origin: url.origin, sandboxId: id });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 409);
      }
      return json({ started: id });
    }

    if (request.method === "POST" && parts[2] === "stop") {
      await container.stop();
      return json({ stopped: id });
    }

    return json({ error: "not found" }, 404);
  },
};
