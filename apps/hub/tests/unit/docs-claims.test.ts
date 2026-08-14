/**
 * Documentation claims that a test can settle, settled by a test.
 *
 * The 2026-08-14 documentation audit found the same shape of bug over and
 * over: a claim written once, far from the code it describes, that nothing
 * could contradict when the code moved. Two families of that claim are cheap
 * to check mechanically, so they are checked here instead of re-read by hand.
 *
 *   1. Environment variables offered to an operator. `SESSION_SECRET` sat in
 *      `.env.example` and `deploy/README-deploy.md` for a year after the hub
 *      stopped reading it — the rename to `BETTER_AUTH_SECRET` shipped with a
 *      plan step that said "remove remaining SESSION_SECRET references" and
 *      the references stayed. A hub deployed from that file ran on the
 *      insecure default and nothing said so. `apps/hub/.env.example` was also
 *      still offering COOLIFY_*, FORGEJO_* and KEYCLOAK_* — three integrations
 *      that have not existed since the pivot.
 *
 *   2. The list of required CI checks. `CONTRIBUTING.md` and `TESTING.md` both
 *      said "four required jobs" and named four; `worker` had been a fifth
 *      since the Cloudflare suite was wired into CI.
 *
 * Both directions matter and both are asserted: an operator must not be
 * offered a variable nothing reads, AND a variable the hub is prepared to NAME
 * IN A BOOT MESSAGE must be written down somewhere an operator will find it.
 * The second half is what would have caught the kaambaan bridge, which shipped
 * able to refuse a boot naming `KAAMBAAN_BRIDGE_AGENTS` while those three
 * variables were written down only in a root `.env.example` that no document
 * pointed at.
 *
 * This deliberately lives in the hub suite rather than a docs-only runner: the
 * `hub` job is a required check, and a check nothing runs is the problem, not
 * the solution.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RuntimeHarness } from "@agentpod/contract";
import { harnessImageEnvVar, providerImageEnvVar } from "../../src/services/runtimes-image";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/**
 * The files that offer an operator a variable to set. `deploy/README-deploy.md`
 * is deliberately NOT here: it is a marked historical record of the first
 * deploy, and holding a record to today's code would force it to stop being a
 * record. That is the whole point of the distinction docs/README.md draws.
 */
const OPERATOR_FACING = [
  "apps/hub/.env.example",
  "docs/DEPLOYMENT.md",
  "docs/OPERATING.md",
] as const;

/** Sources that count as "this codebase reads it". */
const CODE_FILES = [
  "apps/hub/src/config.ts",
  "apps/hub/src/services/provisioner/docker-daemon.ts",
  "apps/hub/src/services/provisioner/cloudflare-sandbox.ts",
  "apps/hub/src/services/provisioner/modal.ts",
  "apps/hub/src/services/provisioner/registry.ts",
  "apps/hub/src/services/runtimes-image.ts",
  "apps/hub/src/services/bridge/config.ts",
  "apps/hub/src/routes/runtime-callback.ts",
  "apps/hub/src/utils/validate-config.ts",
  "apps/console/vite.config.js",
  "apps/console/src/lib/api/client.ts",
] as const;

/**
 * Names that appear in an operator-facing file but are not env vars this repo
 * reads. Each one needs a reason — an unexplained entry here would turn the
 * check back into the prose it replaced.
 */
const NOT_OUR_ENV_VARS: Record<string, string> = {
  URL: "shell local in DEPLOYMENT.md's gVisor install snippet, not an env var the hub reads",
  ARCH: "shell local in the same gVisor snippet — `ARCH=$(uname -m)` picking a release path",
  PATH: "the ordinary shell PATH, exported in the re-deploy section so bun is findable",
};

/** `NAME=` at the start of a line, comment or not. */
const OFFERED_LINE = /^\s*#?\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=/;

function offeredVariables(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const rel of OPERATOR_FACING) {
    for (const line of read(rel).split("\n")) {
      const match = OFFERED_LINE.exec(line);
      if (!match) continue;
      const name = match[1]!;
      found.set(name, [...(found.get(name) ?? []), rel]);
    }
  }
  return found;
}

/**
 * Every env var name the codebase mentions. Deliberately a plain
 * SCREAMING_SNAKE scan rather than a parse of `process.env.X`: the hub reads
 * several through helpers (`getEnv`, `str(env, "…")`, `dockerDaemonSettingsFromEnv`),
 * and a scanner that only understood one syntax would report a live variable
 * as dead — a false red is how a check gets deleted.
 */
function namesMentionedInCode(): Set<string> {
  const names = new Set<string>();
  for (const rel of CODE_FILES) {
    for (const match of read(rel).matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      names.add(match[1]!);
    }
  }
  // Per-harness, per-provider image variables are BUILT, never written out —
  // `NODE_AGENT_FLY_PI_IMAGE` appears in no source file. Ask the builders.
  for (const harness of RuntimeHarness.options) {
    names.add(harnessImageEnvVar(harness));
    for (const provider of ["docker", "cloudflare", "modal", "fly"]) {
      names.add(providerImageEnvVar(harness, provider));
    }
  }
  return names;
}

describe("environment variables an operator is told to set", () => {
  test("are all variables this codebase actually reads", () => {
    const mentioned = namesMentionedInCode();
    const dead: string[] = [];

    for (const [name, files] of offeredVariables()) {
      if (name in NOT_OUR_ENV_VARS) continue;
      if (mentioned.has(name)) continue;
      dead.push(`${name} (offered in ${[...new Set(files)].join(", ")})`);
    }

    // Listed rather than counted, so the failure names the variable and the
    // file — the two things needed to fix it.
    expect(dead).toEqual([]);
  });

  test("every exemption records why it is not our variable", () => {
    for (const [name, reason] of Object.entries(NOT_OUR_ENV_VARS)) {
      expect(reason.length, `${name} must record why`).toBeGreaterThan(20);
    }
  });
});

describe("environment variables the hub names in a boot message", () => {
  /**
   * The scope is deliberate. `config.ts` reads thirty-odd variables, many of
   * them vestigial (`TRAEFIK_*`, `OPENCODE_REGISTRY_*`, `METAMCP_*`) and
   * consumed by nothing — demanding an operator-facing line for each of those
   * would push the docs *away* from the truth, not towards it.
   *
   * What must be documented is the variable the hub is prepared to SAY to an
   * operator: the ones `validate-config.ts` and `docker-daemon.ts` name in a
   * refusal or a warning, and the bridge's three. If the hub can print your
   * name at boot, there has to be somewhere to look you up.
   *
   * This is the assertion that would have caught the kaambaan bridge: it
   * shipped able to refuse a boot naming `KAAMBAAN_BRIDGE_AGENTS`, with those
   * variables written down only in a root `.env.example` that no document
   * pointed at.
   */
  const namesTheHubPrints = (): string[] => {
    const named = new Set<string>();
    for (const rel of [
      "apps/hub/src/utils/validate-config.ts",
      "apps/hub/src/services/provisioner/docker-daemon.ts",
      "apps/hub/src/services/bridge/config.ts",
    ]) {
      // A SCREAMING_SNAKE name inside a string literal in these files is,
      // without exception today, a variable being named to an operator.
      for (const match of read(rel).matchAll(/["'`]([A-Z][A-Z0-9_]{3,})["'`]/g)) {
        named.add(match[1]!);
      }
    }
    return [...named].sort();
  };

  test("the scan finds the names at all", () => {
    // Guard the guard, again: an empty scan passes the assertion below for
    // free, and a regex is exactly the thing that quietly stops matching.
    expect(namesTheHubPrints()).toContain("FLY_API_TOKEN");
    expect(namesTheHubPrints()).toContain("KAAMBAAN_BRIDGE_AGENTS");
  });

  test("are all documented somewhere an operator will look", () => {
    const offered = offeredVariables();
    const undocumented = namesTheHubPrints().filter((n) => !offered.has(n));

    expect(undocumented).toEqual([]);
  });
});

describe("internal links in the live documentation", () => {
  /**
   * Not vanity. `validate-config.ts` sent a failed boot to
   * `docs/production-readiness/phase-1-security.md`, and the landing page sent
   * a reader to the same path — both dead since the pivot moved that directory
   * into the archive. A dead link in a runbook is the reader's dead end at the
   * exact moment they needed the next page.
   *
   * `docs/archive/` and `docs/superpowers/` are excluded on purpose: both are
   * dated records, and a record that has to keep its links working against a
   * moving codebase would have to be edited, which would stop it being a
   * record. Everything else is live and must resolve.
   */
  const LIVE_DOCS = [
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "TESTING.md",
    "docs/README.md",
    "docs/DEPLOYMENT.md",
    "docs/OPERATING.md",
    "docs/archive/README.md",
    "apps/hub/README.md",
    "apps/hub/CLAUDE.md",
    "apps/landing/README.md",
    "fixtures/ecosystem-identity/README.md",
    "fly/node-image/README.md",
    "cloudflare/worker-v2/README.md",
  ] as const;

  /** GitHub's heading-anchor rule, near enough: lowercase, punctuation out, spaces to dashes. */
  const slug = (heading: string): string =>
    heading
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");

  const headingAnchors = (abs: string): Set<string> => {
    const anchors = new Set<string>();
    for (const line of readFileSync(abs, "utf8").split("\n")) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) anchors.add(slug(heading[1]!));
    }
    return anchors;
  };

  test("all resolve — both the file and the #anchor", async () => {
    const { existsSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const broken: string[] = [];

    for (const rel of LIVE_DOCS) {
      const abs = join(REPO_ROOT, rel);
      for (const link of read(rel).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = link[1]!;
        if (/^(https?:|mailto:|#!)/.test(target)) continue;
        const [pathPart, anchor] = target.split("#");

        let targetAbs = abs;
        if (pathPart) {
          targetAbs = resolve(dirname(abs), pathPart);
          if (!existsSync(targetAbs)) {
            broken.push(`${rel} → ${target} (no such file)`);
            continue;
          }
        }
        if (anchor && targetAbs.endsWith(".md") && !headingAnchors(targetAbs).has(anchor)) {
          broken.push(`${rel} → ${target} (no such heading)`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  test("the scan actually reads links", () => {
    // Guard the guard: a link regex that stopped matching would make the
    // assertion above pass on a document full of dead ends.
    const links = [...read("docs/README.md").matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)];
    expect(links.length).toBeGreaterThan(10);
  });
});

describe("the required CI checks", () => {
  /** Job names from ci.yml — `  jobname:` at two-space indent under `jobs:`. */
  const ciJobs = (): string[] => {
    const workflow = read(".github/workflows/ci.yml");
    const jobsSection = workflow.slice(workflow.indexOf("\njobs:"));
    return [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!);
  };

  test("ci.yml defines jobs at all", () => {
    // Guard the guard: a parser that silently matched nothing would make both
    // assertions below vacuously true.
    expect(ciJobs().length).toBeGreaterThan(3);
  });

  test("every CI job is named in CONTRIBUTING.md", () => {
    const contributing = read("CONTRIBUTING.md");
    const missing = ciJobs().filter((job) => !contributing.includes(`\`${job}\``));
    expect(missing).toEqual([]);
  });

  test("every CI job is named in TESTING.md", () => {
    const testing = read("TESTING.md");
    const missing = ciJobs().filter((job) => !testing.includes(`\`${job}\``));
    expect(missing).toEqual([]);
  });
});
