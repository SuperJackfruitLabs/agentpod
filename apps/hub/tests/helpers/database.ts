import { rawSql } from "../../src/db/drizzle";
import { fakePlane, newPrincipalId } from "./fake-plane";

/**
 * A person, for a test.
 *
 * People live at the organization plane now (P3 plan, Task 17: the hub's `"user"` table is gone),
 * so a test user is a human principal in the run's fake plane (`helpers/fake-plane.ts`), not a row.
 * Its id is a `prn_` — what `AuthUser.id` and every `user_id` column hold — unless the test names
 * one. `role: "admin"` seats it in `hub_operators`, the hub's own notion of admin (decision D4).
 */
export interface TestUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function createTestUser(
  userData: Partial<TestUser> = {}
): Promise<TestUser> {
  const testUser: TestUser = {
    id: userData.id || newPrincipalId(),
    email:
      userData.email || `test-${crypto.randomUUID().slice(0, 8)}@example.com`,
    name: userData.name || "Test User",
    emailVerified: userData.emailVerified ?? true,
    role: userData.role || "user",
    createdAt: userData.createdAt || new Date(),
    updatedAt: userData.updatedAt || new Date(),
  };

  fakePlane.addHuman({ id: testUser.id, handle: testUser.email.split("@")[0], displayName: testUser.name });
  if (testUser.role === "admin") {
    await rawSql`INSERT INTO hub_operators (principal_id) VALUES (${testUser.id}) ON CONFLICT DO NOTHING`;
  }

  return testUser;
}

export const TEST_USER_ID = "test-user-123";
export const DEFAULT_USER_ID = "default-user";

export async function getOrCreateDefaultTestUser(): Promise<TestUser> {
  return createTestUser({
    id: TEST_USER_ID,
    email: "test@example.com",
    name: "Test User",
  });
}

export async function setupTestUsers(): Promise<{
  testUser: TestUser;
  apiKeyUser: TestUser;
}> {
  const testUser = await createTestUser({
    id: TEST_USER_ID,
    email: "test@example.com",
    name: "Test User",
  });

  const apiKeyUser = await createTestUser({
    id: DEFAULT_USER_ID,
    email: "default@example.com",
    name: "Default API User",
  });

  return { testUser, apiKeyUser };
}

/**
 * Remove a test user and everything they own — what `DELETE FROM "user"` and its `ON DELETE
 * CASCADE` foreign keys did before those keys were dropped (P3 plan, Task 17; the 18 columns in
 * the plan's inventory). Children before parents: `skill_operations` has no cascade from
 * `skill_artifacts`, and `skill_release_cohorts` restricts `trusted_skill_releases`.
 */
export async function deleteTestUser(userId: string): Promise<void> {
  await deleteTestUsers([userId]);
}

export async function deleteTestUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  for (const id of userIds) fakePlane.remove(id);
  await rawSql`DELETE FROM skill_release_cohorts WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM skill_operations WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM trusted_skill_release_artifacts WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM trusted_skill_releases WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM skill_artifacts WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM station_setups WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM agent_tasks WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM cloudflare_sandboxes WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM matrix_missions WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM stations WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM nodes WHERE user_id = ANY(${userIds})`;
  await rawSql`DELETE FROM admin_audit_log WHERE admin_user_id = ANY(${userIds})`;
  await rawSql`UPDATE admin_audit_log SET target_user_id = NULL WHERE target_user_id = ANY(${userIds})`;
  await rawSql`UPDATE bridge_agents SET created_by = NULL WHERE created_by = ANY(${userIds})`;
  await rawSql`UPDATE station_speech SET updated_by = NULL WHERE updated_by = ANY(${userIds})`;
  await rawSql`UPDATE station_transcription SET updated_by = NULL WHERE updated_by = ANY(${userIds})`;
  await rawSql`UPDATE system_settings SET updated_by = NULL WHERE updated_by = ANY(${userIds})`;
  await rawSql`DELETE FROM hub_operators WHERE principal_id = ANY(${userIds})`;
  await rawSql`DELETE FROM human_matrix_ids WHERE principal_id = ANY(${userIds})`;
}
