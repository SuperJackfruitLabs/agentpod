/**
 * Integration Test: the token createRuntime actually mints.
 *
 * A provisioned runtime on an ephemeral-disk substrate (Cloudflare containers)
 * re-runs `agentpod-node enroll` on EVERY boot, re-presenting the token it was
 * provisioned with. If that token can expire, the runtime is permanently dead
 * the first time it sleeps past the expiry: enroll gets 401, the entrypoint's
 * `set -e` kills the container, and it never dials the hub again.
 *
 * The token lifetime therefore has to be asserted on the path that mints
 * production tokens — createRuntime — not on mintEnrollmentToken directly.
 * Calling the minter directly gets the runtime-bound default and passes happily
 * while createRuntime overrides it with a short TTL, which is exactly how a
 * 30-minute production token shipped under a green suite.
 */

// ─── Env vars BEFORE any src/ imports ─────────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.ENABLE_DOCKER_PROVISIONING = "true";

import { test, expect, beforeAll, afterAll } from "bun:test";

import { rawSql } from "../../src/db/drizzle";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import {
  registerProvisioner,
  resetProvisioners,
} from "../../src/services/provisioner/registry";
import type { RuntimeProvisioner } from "../../src/services/provisioner/types";
import { createRuntime } from "../../src/services/runtimes";

const TEST_USER = "test-user-runtime-token-001";

const fakeDockerProvisioner: RuntimeProvisioner = {
  provider: "docker",
  async provision(spec) {
    return { externalId: `fake-container-${spec.runtimeId}` };
  },
  async destroy() {},
};

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "runtime-token-test@example.com",
    name: "Runtime Token Test User",
  });
  registerProvisioner(fakeDockerProvisioner);
});

afterAll(async () => {
  resetProvisioners();
  try {
    await rawSql`DELETE FROM enrollment_tokens    WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"               WHERE id      = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

test("createRuntime mints an enrollment token that outlives the container", async () => {
  const runtime = await createRuntime(
    TEST_USER,
    { provider: "docker", name: "ttl-box", resourceTier: "small" },
    "https://hub.example.test"
  );

  const rows = (await rawSql`
    SELECT expires_at FROM enrollment_tokens
    WHERE provisioned_runtime_id = ${runtime.id}
  `) as Array<{ expires_at: string | Date }>;

  expect(rows).toHaveLength(1);

  // A year is far past any provisioning window and far short of the ten-year
  // runtime-bound default, so this catches a re-introduced short TTL without
  // pinning the exact constant.
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(rows[0]!.expires_at);
  const lifetimeMs = expiresAt.getTime() - Date.now();
  expect(lifetimeMs).toBeGreaterThan(oneYearMs);
});
