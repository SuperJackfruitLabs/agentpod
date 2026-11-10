import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * fixtures/ecosystem-identity/ moved to treaty, which publishes it as
 * @superjackfruitlabs/treaty-ecosystem-identity (the version pinned in package.json). Until this
 * repository reads the corpus from the package and deletes its copy, the copy must equal the
 * pinned version byte for byte. To move to a newer corpus: bump the package, copy its corpus/
 * files over these, and fix whatever the contract and hub tests then report.
 */
const local = join(import.meta.dir, "..", "..", "..", "fixtures", "ecosystem-identity");
// The package exports each corpus file by name; its folder is the corpus.
const upstream = dirname(
  createRequire(import.meta.url).resolve("@superjackfruitlabs/treaty-ecosystem-identity/token_claims.json"),
);
const json = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".json")).toSorted();

describe("the corpus copy matches treaty's package", () => {
  test("the same files", () => {
    expect(json(local)).toEqual(json(upstream));
  });

  for (const name of json(local)) {
    test(name, () => {
      expect(readFileSync(join(local, name), "utf8") === readFileSync(join(upstream, name), "utf8")).toBe(true);
    });
  }
});
