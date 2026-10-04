/**
 * Are the pinned ACP adapter versions behind what is published?
 *
 *   bun run scripts/check-acp-adapter-pins.ts          # report
 *   bun run scripts/check-acp-adapter-pins.ts --check  # exit 1 on drift
 *
 * Three harnesses reach ACP through an adapter this repo spawns by an
 * exact version: `npx -y @agentclientprotocol/codex-acp@<pinned>`. The pin is
 * deliberate and must stay — `codex.go` says why at length: an unpinned
 * `npx -y <pkg>` would change every node's adapter the moment a new version
 * published, mid-flight, with no way to tell which version a session ran.
 *
 * But pinning only moves the upgrade from "automatic and invisible" to
 * "deliberate and someone's job", and nothing here made it anyone's job. On
 * 2026-10-04 `codex-acp` was pinned at 1.12.0 against 2.1.1 published — a major
 * version, on every Codex session in the fleet — and `claude-agent-acp` at
 * 0.66.0 against 0.85.1. Nothing in the repository compared those numbers.
 * `codex_runtime.go` does carry advice about updating, but it fires only when
 * the INSTALLED adapter is exactly 1.1.14 and recommends the pin, so it can
 * never name anything newer than what is already pinned.
 *
 * This does not upgrade anything. Upgrading is a decision, taken with the
 * harness contract tests behind it; the job of this script is to make sure the
 * decision is *offered* instead of being discovered by an operator asking for a
 * model the bundled engine does not have.
 *
 * Two deliberate choices worth keeping:
 *
 *   * **The pins are read, never restated.** Any `…ACPPackage = "pkg@version"`
 *     in the descriptor package is found by scanning, so an adapter added for a
 *     seventh harness is covered the day it lands rather than the day somebody
 *     remembers this file. A second copy of a version number is the bug this
 *     script exists to catch.
 *   * **A network failure is not drift.** npm being unreachable says nothing
 *     about the pins, and a guard that fails the build on a transient outage is
 *     a guard somebody disables — which leaves the pins less watched than
 *     before it existed. Unreachable is reported and exits 0; only a version
 *     that is genuinely behind fails.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESCRIPTOR_DIR = join(REPO, "apps/node-agent/internal/descriptor");
const check = process.argv.includes("--check");

interface Pin {
  /** The Go constant's name, for the report. */
  constant: string;
  /** The file it lives in, relative to the repo. */
  file: string;
  /** Package name without the version — scoped names keep their leading `@`. */
  pkg: string;
  /** The pinned version. */
  version: string;
}

/**
 * Split `@scope/name@1.2.3` into its package and version.
 *
 * On the LAST `@`, not the first: a scoped package's name begins with one, and
 * splitting on the first would yield an empty package and `scope/name@1.2.3` as
 * a version — which would then "exist" on npm never, and report as drift
 * forever.
 */
function splitPinned(spec: string): { pkg: string; version: string } | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const pkg = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!pkg || !version) return null;
  return { pkg, version };
}

function findPins(): Pin[] {
  const pins: Pin[] = [];
  for (const name of readdirSync(DESCRIPTOR_DIR).sort()) {
    if (!name.endsWith(".go") || name.endsWith("_test.go")) continue;
    const src = readFileSync(join(DESCRIPTOR_DIR, name), "utf8");
    for (const m of src.matchAll(/(\w*ACPPackage)\s*=\s*"([^"]+)"/g)) {
      const split = splitPinned(m[2]!);
      if (!split) continue;
      pins.push({
        constant: m[1]!,
        file: `apps/node-agent/internal/descriptor/${name}`,
        ...split,
      });
    }
  }
  return pins;
}

/**
 * Is `candidate` a later release than `pinned`?
 *
 * Numeric, dot-separated, shorter-is-older on a tie (`1.2` < `1.2.1`). A
 * prerelease suffix is treated as the release it qualifies, which is the honest
 * reading for this purpose: `2.0.0-rc.1` being published is not a reason to say
 * a `1.x` pin is behind, and npm's `latest` tag does not point at prereleases
 * anyway.
 */
function isNewer(candidate: string, pinned: string): boolean {
  const parts = (v: string) =>
    v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(pinned);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function publishedLatest(pkg: string): Promise<string> {
  // No `application/vnd.npm.install-v1+json` accept header here, deliberately:
  // npm's abbreviated-metadata type is only served for the whole packument, and
  // asking for it on `/latest` answers 406. The full document for ONE version is
  // smaller than the abbreviated document for every version anyway.
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`npm answered ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !body.version) {
    throw new Error("npm returned no version");
  }
  return body.version;
}

const pins = findPins();
if (pins.length === 0) {
  // Not "nothing to do": the descriptors reach ACP through pinned adapters, so
  // finding none means the scan broke (a renamed constant, a moved package) and
  // reporting success would retire the guard silently.
  console.error(
    `✗ no ACP adapter pins found under ${DESCRIPTOR_DIR}.\n` +
      `  The scan looks for \`…ACPPackage = "pkg@version"\`. If a constant was\n` +
      `  renamed, update the pattern in this script — do not assume there is\n` +
      `  nothing to check.`,
  );
  process.exit(1);
}

let behind = 0;
let unreachable = 0;

for (const pin of pins) {
  let latest: string;
  try {
    latest = await publishedLatest(pin.pkg);
  } catch (err) {
    unreachable++;
    console.warn(`  ? ${pin.pkg} — could not ask npm (${(err as Error).message})`);
    continue;
  }
  if (isNewer(latest, pin.version)) {
    behind++;
    console.error(`  ✗ ${pin.pkg}  pinned ${pin.version}  published ${latest}  (${pin.constant})`);
  } else {
    console.log(`  ✓ ${pin.pkg}  ${pin.version}`);
  }
}

if (unreachable > 0 && behind === 0) {
  console.warn(
    `\n${unreachable} of ${pins.length} adapter(s) could not be checked. ` +
      `Not treated as drift — see this script's header.`,
  );
}

if (behind > 0) {
  console.error(
    `\n${behind} ACP adapter pin(s) behind what npm publishes.\n\n` +
      `Raising a pin is a decision, not a formality: the adapter bundles the\n` +
      `harness engine, so a new major can change what the harness itself does.\n` +
      `To raise one:\n\n` +
      `  1. edit the constant in the file named above\n` +
      `  2. run the node-agent's ACP tests against the new adapter\n` +
      `  3. note the version you verified against in the commit\n\n` +
      `A pin that should NOT be raised yet is still worth recording — say so in\n` +
      `the constant's comment so the next reader is not re-deciding it.`,
  );
  if (check) process.exit(1);
}

if (behind === 0 && unreachable === 0) console.log("\n✓ every ACP adapter pin is current");
