import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../..");
const source = readFileSync(join(repoRoot, "apps/hub/src/db/drizzle.ts"), "utf8");

/**
 * Issue #322. `initDatabase()`'s docstring listed four things it does. It did
 * one of them.
 *
 *   - Runs pending migrations      — true
 *   - Enables pgvector extension   — never called `enableVectorExtension()`
 *   - Creates vector indexes       — nothing does this
 *   - Seeds reference data         — nothing does this
 *
 * The issue reported the pgvector line; the other two came out of reading the
 * body against the list, which is what this test now does mechanically.
 *
 * pgvector is not optional here, which is why the fix calls it rather than
 * deleting the sentence: migration 0000 creates `"embedding" vector(1536)`,
 * and no migration runs `CREATE EXTENSION`. Against a database where nobody
 * ran it by hand, the first migration fails on a type that does not exist.
 * That the suite has been green only means every database it has ever met
 * happened to have the extension already.
 */
describe("initDatabase's docstring describes what it does (#322)", () => {
  const body = (() => {
    const start = source.indexOf("export async function initDatabase");
    expect(start).toBeGreaterThan(-1);
    // To the next top-level `}` at column 0 — these are all plain declarations.
    const end = source.indexOf("\n}", start);
    return source.slice(start, end);
  })();

  /**
   * The BULLET LINES of the docstring, which is where it makes claims. Prose
   * around them explains history — including, now, a sentence recording that
   * this function once claimed vector indexes and seed data it never created.
   * Scanning the whole comment would read that history as a fresh claim and
   * fail forever, which is a neat illustration of why the scope is the list.
   */
  const claimLines = (() => {
    const at = source.indexOf("export async function initDatabase");
    const before = source.slice(0, at);
    const open = before.lastIndexOf("/**");
    expect(open).toBeGreaterThan(-1);
    return before
      .slice(open)
      .split("\n")
      .filter((l) => /^\s*\*\s*-\s/.test(l))
      .join("\n");
  })();

  test("enables the pgvector extension, which its migrations require", () => {
    expect(body).toContain("enableVectorExtension(");
  });

  test("enables the extension BEFORE running migrations", () => {
    const enable = body.indexOf("enableVectorExtension(");
    const migrate = body.indexOf("runMigrations(");

    expect(enable).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(-1);
    // Order is the whole point: migration 0000 declares a `vector` column, so
    // enabling afterwards would be enabling it for the migration that already
    // failed.
    expect(enable).toBeLessThan(migrate);
  });

  test("claims nothing it does not do", () => {
    // Each claim in the docstring must be traceable to a call in the body.
    // Keyed by the word that identifies the claim, valued by what would have
    // to be there for it to be true.
    const claims: Array<{ says: RegExp; needs: string }> = [
      { says: /migrations/i, needs: "runMigrations(" },
      { says: /pgvector|vector extension/i, needs: "enableVectorExtension(" },
      { says: /vector index/i, needs: "createVectorIndexes(" },
      { says: /seed/i, needs: "seed" },
    ];

    const broken = claims
      .filter((c) => c.says.test(claimLines))
      .filter((c) => !body.includes(c.needs))
      .map((c) => `docstring claims ${c.says} but the body never calls ${c.needs}`);

    expect(broken).toEqual([]);
  });
});
