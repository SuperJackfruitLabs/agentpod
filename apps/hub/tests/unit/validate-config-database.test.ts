import { describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import { collectConfigErrors } from "../../src/utils/validate-config";

/**
 * Issue #321. The production rule that refuses a boot on the development
 * database password read `DATABASE_PATH` — a pre-pivot SQLite leftover that no
 * deployment sets — while reporting the field as `DATABASE_URL`, the variable
 * the hub actually connects with.
 *
 * So the guard inspected an empty variable, found nothing, and passed. It had
 * never once fired. This is the third time in two days the same shape has
 * turned up here: a check that is green because it is looking somewhere empty
 * (the `acp` capability advertised on a binary merely resolving; the posture
 * scanner grading machines "A" without opening the files it graded).
 *
 * A rule that has never fired has also never been proven to fire, so these
 * tests assert both directions: that it catches a real production URL, and
 * that it cannot be satisfied by the legacy variable it used to read.
 */
describe("the production dev-password database refusal (#321)", () => {
  const production = (database: Record<string, unknown>) => ({
    ...config,
    nodeEnv: "production",
    database: { ...config.database, ...database },
  });

  const databaseErrors = (cfg: ReturnType<typeof production>) =>
    collectConfigErrors(cfg as unknown as typeof config, () => {}).filter(
      (e) => e.field === "DATABASE_URL"
    );

  test("refuses a production boot whose DATABASE_URL carries the dev password", () => {
    const errors = databaseErrors(
      production({
        url: "postgres://agentpod:agentpod-dev-password@db.internal:5432/agentpod",
      })
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("dev password");
  });

  test("allows a production boot with a real password", () => {
    const errors = databaseErrors(
      production({ url: "postgres://agentpod:S6mKq2xT9wZ@db.internal:5432/agentpod" })
    );

    expect(errors).toEqual([]);
  });

  test("inspects the variable the hub connects with, not the legacy DATABASE_PATH", () => {
    // The regression. Before the fix this passed for the wrong reason: the rule
    // read `path`, so a dev password in the URL the hub actually uses went
    // unseen. A future edit that points the rule back at any field other than
    // the connection URL fails here.
    const errors = databaseErrors(
      production({
        path: "./data/database.sqlite", // clean, and irrelevant — nothing reads it
        url: "postgres://agentpod:agentpod-dev-password@db.internal:5432/agentpod",
      })
    );

    expect(errors).toHaveLength(1);
  });

  test("does not fire outside production", () => {
    const errors = collectConfigErrors(
      {
        ...config,
        nodeEnv: "development",
        database: {
          ...config.database,
          url: "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod",
        },
      } as unknown as typeof config,
      () => {}
    ).filter((e) => e.field === "DATABASE_URL");

    expect(errors).toEqual([]);
  });
});
