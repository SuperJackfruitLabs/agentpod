import { Container, getContainer } from "@cloudflare/containers";
import { isAuthorised } from "./auth";

interface Env {
  // Typed with the container class so getContainer returns a stub carrying its
  // lifecycle methods — an untyped namespace would need casts at every call
  // site, and a cast is where a wrong method name survives to runtime.
  NODE_AGENT: DurableObjectNamespace<NodeAgentContainer>;
  AGENTPOD_WORKER_TOKEN?: string;
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
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }) {
    console.log("[agentpod] container stopped", { exitCode, reason });
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
   * Safe because a woken container re-enrols and resumes the same nodeId
   * (runtime identity persistence, #245). Before that, sleeping lost the station.
   */
  override async onActivityExpired() {
    console.log("[agentpod] idle — sleeping");
    await this.notifyHub("asleep");
    await this.stop();
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
      await c.start({
        envVars: {
          AGENTPOD_HUB_URL: body.hubUrl,
          AGENTPOD_ENROLL_TOKEN: body.enrollToken,
          // Read by the container class's notifyHub, not by agentpod-node.
          AGENTPOD_RUNTIME_ID: body.id,
          AGENTPOD_RUNTIME_CALLBACK_TOKEN: body.callbackToken,
        },
      });
      return json({ sandboxId: body.id }, 201);
    }

    const id = parts[1];
    if (!id) return json({ error: "not found" }, 404);

    const container = getContainer(env.NODE_AGENT, id);

    if (request.method === "GET" && !parts[2]) {
      return json({ sandboxId: id });
    }

    if (request.method === "DELETE" && !parts[2]) {
      await container.destroy();
      return json({ destroyed: id });
    }

    // Also the wake path: to this worker a wake IS a start, and the spike
    // confirmed stop → start restarts a container reliably.
    if (request.method === "POST" && parts[2] === "start") {
      await container.start();
      return json({ started: id });
    }

    if (request.method === "POST" && parts[2] === "stop") {
      await container.stop();
      return json({ stopped: id });
    }

    return json({ error: "not found" }, 404);
  },
};
