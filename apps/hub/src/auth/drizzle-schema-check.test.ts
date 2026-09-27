/**
 * The Drizzle schema carries every column Better Auth's enabled plugins write.
 *
 * Since 1.7.3 Better Auth checks this at startup, in production too, and on a
 * mismatch it rejects every auth request — sign-in, /api/auth/token and
 * /api/auth/jwks alike. The integration suites catch that only as a spread of
 * unrelated-looking 500s; this names the missing column. The check compares
 * the Drizzle schema object, not the live database, so no connection is used.
 */
import { expect, test } from "bun:test";
import { auth } from "./drizzle-auth";

test("Better Auth accepts the hub's Drizzle schema", async () => {
  const ctx = (await auth.$context) as { checkSchema?: () => Promise<void> | undefined };
  // Absent would mean validation was turned off, which is the failure this guards.
  expect(ctx.checkSchema).toBeFunction();
  await ctx.checkSchema!();
});
