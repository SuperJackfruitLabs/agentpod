import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { SkillInventory } from "@agentpod/contract";
import * as broker from "../services/broker";
import { getStation } from "../services/station-registry";
import { gateCapability } from "./station-writes";
import type { AuthUser } from "../auth/middleware";

/** Read-only metadata. No caller-selected root, source body or mutation. */
export const stationSkillsRoutes = new Hono().post(
  "/stations/:id/skills/inventory",
  zValidator("json", z.object({}).strict()),
  async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous")
      return c.json({ error: "Unauthorized" }, 401);
    const station = await getStation(user.id, c.req.param("id"));
    if (!station || station.tenantId !== user.tenantId)
      return c.json({ error: "Not Found" }, 404);
    if (!gateCapability(station, "skills.inventory")) {
      return c.json(
        { error: "Station does not advertise skill inventory" },
        403,
      );
    }
    const result = await broker.request(station.nodeId, "skills.inventory", {
      key: station.stationKey,
    });
    if (!result.ok) {
      const offline =
        result.error === "node offline" || result.error === "node disconnected";
      return c.json(
        { error: result.error ?? "Skill inventory failed" },
        offline ? 409 : 502,
      );
    }
    const parsed = SkillInventory.safeParse(result.data);
    if (
      !parsed.success ||
      parsed.data.stationKey !== station.stationKey ||
      parsed.data.harness !== station.harness
    ) {
      return c.json({ error: "Node returned an invalid skill inventory" }, 502);
    }
    // Like health/changeset.status, metadata refreshes are not audit mutations.
    return c.json(parsed.data);
  },
);
