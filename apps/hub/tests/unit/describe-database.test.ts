import { describe, expect, test } from "bun:test";
import { describeDatabase } from "../../src/utils/describe-database";

/**
 * The boot banner printed `config.database.path` — `./data/database.sqlite`,
 * a pre-pivot default that no deployment sets and nothing connects to. Every
 * hub boot has told its operator the wrong database, in the one place they are
 * most likely to look for it. Same root as #321: `database.path` is a lie, and
 * fixing only the validation rule would have left the lie on screen.
 *
 * A banner cannot print DATABASE_URL raw — it carries the password, and boot
 * output goes to journald, CI logs and screenshots. So it prints what an
 * operator needs to identify the database (host, port, name, user) and never
 * the secret.
 */
describe("describeDatabase", () => {
  test("keeps host, port, database and user", () => {
    const out = describeDatabase("postgres://agentpod:s3cret@db.internal:5432/agentpod");
    expect(out).toContain("db.internal:5432");
    expect(out).toContain("agentpod");
  });

  test("never prints the password", () => {
    const out = describeDatabase("postgres://agentpod:hunter2@db.internal:5432/agentpod");
    expect(out).not.toContain("hunter2");
  });

  test("hides a password containing URL-ish punctuation", () => {
    const out = describeDatabase("postgres://u:p%40ss%2Fw0rd@db.internal:5432/agentpod");
    expect(out).not.toContain("p%40ss");
    expect(out).not.toContain("w0rd");
  });

  test("says so when the variable is unset, rather than inventing a default", () => {
    expect(describeDatabase("")).toContain("not set");
    expect(describeDatabase(undefined as unknown as string)).toContain("not set");
  });

  test("does not throw on a malformed URL, and still hides what follows a colon", () => {
    // A banner must never be the reason a boot dies, and an unparseable value
    // is exactly when someone has pasted something wrong — possibly a secret.
    const out = describeDatabase("this is not a url:with-a-secret");
    expect(out).not.toContain("with-a-secret");
    expect(out.length).toBeGreaterThan(0);
  });
});
