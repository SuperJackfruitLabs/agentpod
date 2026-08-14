import { describe, expect, test } from "bun:test";
import { scanEnvNames, stripComments } from "../helpers/scan-env-names";

/**
 * Issue #323. The docs-claims scanner finds the environment variables the hub
 * is prepared to NAME to an operator, by matching SCREAMING_SNAKE inside string
 * literals in the three files that print such names.
 *
 * It could not tell a backticked reference inside a JSDoc comment from a string
 * literal in code. A comment reading "Unset means `DEFAULT_PERMISSION_WAIT_MS`"
 * therefore reported an exported TypeScript constant as an undocumented
 * environment variable, on PR #319, for a variable that does not exist.
 *
 * The reason this mattered more than an annoying red: the obvious way to make
 * it green was to document `DEFAULT_PERMISSION_WAIT_MS=` in an operator-facing
 * file — offering a setting that does nothing. That is exactly the SESSION_SECRET
 * defect these checks were added to prevent, and it would have PASSED the check
 * while making the documentation less true. A check whose failure is fixed by
 * writing something false is worse than no check.
 *
 * Stripping comments is the fix rather than matching only read positions
 * (`process.env.X`, `getEnv("X")`), because the names that matter most here
 * appear in refusal messages and `field:` labels — string literals, not reads.
 * Narrowing to reads would have blinded the check to the very thing it exists
 * to catch.
 */
describe("stripComments", () => {
  test("removes a line comment", () => {
    expect(stripComments('const a = 1; // SOME_NAME\n')).not.toContain("SOME_NAME");
  });

  test("removes a block comment and a JSDoc", () => {
    expect(stripComments("/* SOME_NAME */ const a = 1;")).not.toContain("SOME_NAME");
    expect(stripComments("/**\n * Unset means `SOME_NAME`.\n */\nconst a = 1;")).not.toContain(
      "SOME_NAME"
    );
  });

  test("keeps code, including string literals", () => {
    const out = stripComments('const a = "KEEP_ME"; // DROP_ME');
    expect(out).toContain("KEEP_ME");
    expect(out).not.toContain("DROP_ME");
  });

  test("does not mistake a URL's slashes for a comment", () => {
    // The trap in every naive comment stripper. `https://` must survive, or the
    // rest of the line — real code — vanishes with it.
    const out = stripComments('const u = "https://hub.agentpod.dev"; const b = "KEEP_ME";');
    expect(out).toContain("https://hub.agentpod.dev");
    expect(out).toContain("KEEP_ME");
  });

  test("does not mistake an asterisk inside a string for a block comment", () => {
    const out = stripComments('const glob = "/*"; const b = "KEEP_ME";');
    expect(out).toContain("KEEP_ME");
  });

  test("leaves a comment marker inside a string alone", () => {
    expect(stripComments('const s = "// not a comment"; const b = "KEEP_ME";')).toContain(
      "KEEP_ME"
    );
  });
});

describe("scanEnvNames (#323)", () => {
  test("finds a name the hub would print to an operator", () => {
    expect(scanEnvNames('errors.push({ field: "DATABASE_URL" });')).toContain("DATABASE_URL");
  });

  test("matches a whole string literal, not a name buried in prose", () => {
    // Deliberate, and worth stating because it looks like a miss. Matching
    // names INSIDE longer messages was measured against the three scanned
    // files: it finds three more real variables (ENABLE_CLOUDFLARE_SANDBOXES,
    // DOCKER_PORT, CERT_FILES) and nine English words — CONFIGURATION, WARNING,
    // FAILED, README, CREATE, DEPLOYMENT, VALIDATION, WIDE, WORKSPACE — each of
    // which would then demand an operator-facing line for a variable that does
    // not exist. That is the same "green by writing something false" trap #323
    // is about, pointing the other way.
    //
    // The gap is real but needs a rule that can tell a variable from a noun,
    // which this is not. Tracked rather than smuggled in here.
    expect(scanEnvNames('throw new Error("Set KAAMBAAN_BASE_URL first");')).not.toContain(
      "KAAMBAAN_BASE_URL"
    );
    expect(scanEnvNames('const k = "KAAMBAAN_BASE_URL";')).toContain("KAAMBAAN_BASE_URL");
  });

  test("ignores a backticked constant named in a comment — the #319 false red", () => {
    const source = [
      "/**",
      " * How long a permission question waits for a human.",
      " * Unset means `DEFAULT_PERMISSION_WAIT_MS`.",
      " */",
      "export const DEFAULT_PERMISSION_WAIT_MS = 30 * 60 * 1000;",
    ].join("\n");

    // Named only in a comment and as a bare identifier — never in a string
    // literal, because it is not a variable anyone can set.
    expect(scanEnvNames(source)).not.toContain("DEFAULT_PERMISSION_WAIT_MS");
  });

  test("still finds a real variable in a file that also comments about a constant", () => {
    const source = [
      "/** Unset means `DEFAULT_PERMISSION_WAIT_MS`. */",
      'const enabled = getEnv("ENABLE_KAAMBAAN_BRIDGE") === "true";',
    ].join("\n");

    const names = scanEnvNames(source);
    expect(names).toContain("ENABLE_KAAMBAAN_BRIDGE");
    expect(names).not.toContain("DEFAULT_PERMISSION_WAIT_MS");
  });
});
