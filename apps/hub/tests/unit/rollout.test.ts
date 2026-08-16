import { describe, expect, test } from "bun:test";
import { executeRollout, planRollout, type RolloutNode } from "../../src/services/rollout";

/**
 * Issue #295. Nothing ever asked the fleet to update: no ticker in the agent,
 * no scheduler in the hub, no check on connect. Self-update had exactly two
 * triggers, both a human — `apn update` on the host, or one console button per
 * node. So the fleet sat on whatever version it was installed with, and on
 * 2026-08-13 that was three releases behind while the docs read as if updates
 * were automatic.
 *
 * The chosen answer is a hub-driven rollout rather than an agent-side timer:
 * the hub already knows every node's version and the latest tag, and an
 * unattended binary swap plus service restart across nodes running live agent
 * sessions is the option most likely to bite at the worst moment. The hub
 * decides, on an operator's command, in an order they can read afterwards.
 *
 * The planner is pure so these rules can be argued with directly — which node
 * is touched, and why one was not, is the part an operator has to trust.
 */

const node = (over: Partial<RolloutNode> = {}): RolloutNode => ({
  id: "node_1",
  name: "alpha",
  status: "online",
  agentVersion: "v0.1.22",
  latestVersion: "v0.1.26",
  updateAvailable: true,
  ...over,
});

describe("planRollout", () => {
  test("updates an online node that is behind", () => {
    const plan = planRollout([node()], {});
    expect(plan).toHaveLength(1);
    expect(plan[0]!.action).toBe("update");
  });

  test("skips an offline node, and says so rather than failing it", () => {
    // A node that is not connected cannot be updated, and calling that a
    // failure would make every rollout report failures for machines that are
    // simply switched off. cloudchamber has been offline since 2026-08-13.
    const plan = planRollout([node({ status: "offline" })], {});
    expect(plan[0]!.action).toBe("skip");
    expect(plan[0]!.reason).toContain("offline");
  });

  test("skips a node already on the latest version", () => {
    const plan = planRollout(
      [node({ agentVersion: "v0.1.26", updateAvailable: false })],
      {}
    );
    expect(plan[0]!.action).toBe("skip");
    expect(plan[0]!.reason).toContain("current");
  });

  test("skips a node whose version is unknown, instead of guessing", () => {
    const plan = planRollout(
      [node({ agentVersion: null, updateAvailable: false })],
      {}
    );
    expect(plan[0]!.action).toBe("skip");
    expect(plan[0]!.reason).toContain("unknown");
  });

  test("skips everything when the latest release could not be resolved", () => {
    // getLatestAgentVersion returns null on a cold start with GitHub
    // unreachable. Updating the fleet towards an unknown target is worse than
    // doing nothing, and `force` must not override THIS — there is no target.
    const plan = planRollout(
      [node({ latestVersion: null, updateAvailable: false })],
      { force: true }
    );
    expect(plan[0]!.action).toBe("skip");
    expect(plan[0]!.reason).toContain("latest release");
  });

  test("force updates a node that is already current, but still not an offline one", () => {
    const plan = planRollout(
      [
        node({ id: "a", name: "alpha", agentVersion: "v0.1.26", updateAvailable: false }),
        node({ id: "b", name: "bravo", status: "offline" }),
      ],
      { force: true }
    );
    expect(plan.find((p) => p.nodeId === "a")!.action).toBe("update");
    expect(plan.find((p) => p.nodeId === "b")!.action).toBe("skip");
  });

  test("restricts to the named nodes when `only` is given", () => {
    const plan = planRollout(
      [node({ id: "a", name: "alpha" }), node({ id: "b", name: "bravo" })],
      { only: ["b"] }
    );
    expect(plan.map((p) => p.nodeId)).toEqual(["b"]);
  });

  test("orders by name, so a rollout is reproducible and readable", () => {
    const plan = planRollout(
      [node({ id: "c", name: "charlie" }), node({ id: "a", name: "alpha" }), node({ id: "b", name: "bravo" })],
      {}
    );
    expect(plan.map((p) => p.name)).toEqual(["alpha", "bravo", "charlie"]);
  });
});

describe("executeRollout", () => {
  const updatePlan = (ids: string[]) =>
    ids.map((id) => ({ nodeId: id, name: id, action: "update" as const }));

  test("updates one node at a time by default", async () => {
    // The point of a throttle. Restarting every node in a fleet at once is how
    // an update becomes an outage; the hub has the whole picture precisely so
    // it can go in order.
    let inFlight = 0;
    let peak = 0;

    await executeRollout(updatePlan(["a", "b", "c"]), {
      request: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ok: true, data: { ok: true, updating: true, tag: "v0.1.26" } };
      },
    });

    expect(peak).toBe(1);
  });

  test("keeps going after one node fails, and reports which", async () => {
    const results = await executeRollout(updatePlan(["a", "b", "c"]), {
      request: async (nodeId) =>
        nodeId === "b"
          ? { ok: false, error: "node offline" }
          : { ok: true, data: { ok: true, updating: true, tag: "v0.1.26" } },
    });

    expect(results.map((r) => r.outcome)).toEqual(["updated", "failed", "updated"]);
    expect(results[1]!.error).toContain("offline");
  });

  test("treats a round-trip that succeeded with a failed update as a failure", async () => {
    // The download 404'd or the checksum did not match. Reporting that as
    // success is the same class of lie the single-node route refuses to tell —
    // a silently failed update leaves the node on the old binary.
    const results = await executeRollout(updatePlan(["a"]), {
      request: async () => ({
        ok: true,
        data: { ok: false, error: "checksum mismatch" },
      }),
    });

    expect(results[0]!.outcome).toBe("failed");
    expect(results[0]!.error).toContain("checksum");
  });

  test("records a node that answered but had nothing to do", async () => {
    const results = await executeRollout(updatePlan(["a"]), {
      request: async () => ({
        ok: true,
        data: { ok: true, updating: false, reason: "already on v0.1.26" },
      }),
    });

    expect(results[0]!.outcome).toBe("no-op");
    expect(results[0]!.reason).toContain("already");
  });

  test("carries skipped nodes through to the result, unattempted", async () => {
    let calls = 0;
    const results = await executeRollout(
      [
        { nodeId: "a", name: "alpha", action: "update" },
        { nodeId: "b", name: "bravo", action: "skip", reason: "offline" },
      ],
      {
        request: async () => {
          calls++;
          return { ok: true, data: { ok: true, updating: true, tag: "v0.1.26" } };
        },
      }
    );

    expect(calls).toBe(1);
    expect(results.find((r) => r.nodeId === "b")!.outcome).toBe("skipped");
    expect(results.find((r) => r.nodeId === "b")!.reason).toBe("offline");
  });

  test("an exception from the broker is a failed node, not a failed rollout", async () => {
    const results = await executeRollout(updatePlan(["a", "b"]), {
      request: async (nodeId) => {
        if (nodeId === "a") throw new Error("socket exploded");
        return { ok: true, data: { ok: true, updating: true, tag: "v0.1.26" } };
      },
    });

    expect(results[0]!.outcome).toBe("failed");
    expect(results[0]!.error).toContain("socket exploded");
    expect(results[1]!.outcome).toBe("updated");
  });
});

// ─── A node whose binary comes from an image (#349) ───────────────────────────

/**
 * `cf-opencode` went offline when someone pressed Update, and stayed on
 * v0.1.22. Self-update swaps a binary and exits, expecting a supervisor; a
 * Cloudflare container has none, so the exit IS the stop. And the disk is
 * ephemeral, so the swapped binary would not survive the restart it never got.
 *
 * A fleet rollout that did this to every Cloudflare station is a much worse
 * outcome than one that updates nothing, so the planner has to know.
 */
describe("nodes whose image is a deployment artifact", () => {
  test("are skipped, and the reason says how to update them instead", () => {
    const [item] = planRollout([node({ imageFixed: true })], {});

    expect(item!.action).toBe("skip");
    // A bare "not supported" would leave an operator with a stale station and
    // no next step. The path that works is naming the image.
    expect(item!.reason).toMatch(/image/i);
  });

  test("are skipped even under force, because force cannot make this work", () => {
    // force overrides policy choices. This is not one: the binary cannot
    // persist and the attempt stops the station.
    const [item] = planRollout([node({ imageFixed: true })], { force: true });

    expect(item!.action).toBe("skip");
  });

  test("do not stop the rest of the fleet being updated", () => {
    const plan = planRollout(
      [node({ id: "n1", name: "alpha", imageFixed: true }), node({ id: "n2", name: "beta" })],
      {}
    );

    expect(plan.find((p) => p.nodeId === "n1")!.action).toBe("skip");
    expect(plan.find((p) => p.nodeId === "n2")!.action).toBe("update");
  });

  test("an ordinary node is untouched by this rule", () => {
    expect(planRollout([node()], {})[0]!.action).toBe("update");
    expect(planRollout([node({ imageFixed: false })], {})[0]!.action).toBe("update");
  });
});
