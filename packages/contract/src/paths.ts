/**
 * The station file denylist: paths in a station's workspace that are never served to the
 * console (keys, credentials, a harness's own token files).
 *
 * The node enforces it (apps/node-agent/internal/descriptor/artifact.go, `Denied`); the hub
 * refuses the same paths before it asks the node, so a node that predates the node-side fix
 * still never reads one for a console request. Both read the vectors in
 * fixtures/denied-paths-v1.json, so a rule changed on one side fails the other's test.
 *
 * Matching ignores case, treats `\` as `/`, and strips trailing dots and spaces from each
 * segment (Windows-style names that open the same file).
 */

type Rule = { rule: string; test: (segs: string[]) => boolean };

const anySeg = (pred: (s: string) => boolean) => (segs: string[]) => segs.some(pred);
/** A folder segment: anywhere but the last. */
const dirSeg = (name: string) => (segs: string[]) => segs.slice(0, -1).includes(name);
const base = (pred: (b: string) => boolean) => (segs: string[]) => pred(segs[segs.length - 1] ?? "");
/** The parts as a consecutive run anywhere in the path. */
const sub =
  (...parts: string[]) =>
  (segs: string[]) => {
    for (let i = 0; i + parts.length <= segs.length; i++) {
      if (parts.every((p, j) => segs[i + j] === p)) return true;
    }
    return false;
  };

const HISTORY = new Set([
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
]);
const HARNESS_DIRS = [".claude", ".codex", ".gemini", ".cursor", ".hermes", ".openclaw", ".opencode", ".pi"];

/** In the node's order: the first rule a path breaks is the one reported. */
const DENIED_RULES: Rule[] = [
  { rule: ".env*", test: anySeg((s) => s.startsWith(".env")) },
  { rule: ".ssh/", test: dirSeg(".ssh") },
  { rule: ".gnupg/", test: dirSeg(".gnupg") },
  { rule: "*.pem", test: base((b) => b.endsWith(".pem")) },
  { rule: "*.key", test: base((b) => b.endsWith(".key")) },
  { rule: "id_*", test: base((b) => b.startsWith("id_")) },
  { rule: ".git/", test: dirSeg(".git") },
  { rule: ".netrc", test: base((b) => b === ".netrc") },
  { rule: ".npmrc", test: base((b) => b === ".npmrc") },
  { rule: ".pypirc", test: base((b) => b === ".pypirc") },
  { rule: ".config/gh/hosts.yml", test: sub(".config", "gh", "hosts.yml") },
  { rule: "shell history", test: base((b) => HISTORY.has(b)) },
  { rule: ".git-credentials", test: base((b) => b === ".git-credentials") },
  {
    rule: "cloud credentials",
    test: (s) =>
      dirSeg(".aws")(s) ||
      dirSeg(".azure")(s) ||
      dirSeg(".kube")(s) ||
      sub(".config", "gcloud")(s) ||
      sub(".docker", "config.json")(s) ||
      base((b) => b === "application_default_credentials.json" || b === "credentials.json")(s),
  },
  {
    rule: "harness files",
    test: (s) =>
      HARNESS_DIRS.some((d) => dirSeg(d)(s)) ||
      base((b) => b === ".claude.json" || b === "auth.json" || b === ".credentials.json")(s) ||
      sub(".config", "opencode")(s) ||
      sub(".local", "share", "opencode")(s) ||
      sub(".config", "goose")(s),
  },
];

function segments(rel: string): string[] {
  const out: string[] = [];
  for (const s of rel.replaceAll("\\", "/").split("/")) {
    if (s === "" || s === ".") continue;
    out.push(s.toLowerCase().replace(/[. ]+$/, ""));
  }
  return out;
}

/** The rule a workspace-relative path breaks, or null when it is an ordinary path. */
export function deniedRule(rel: string): string | null {
  const segs = segments(rel);
  if (segs.length === 0) return null;
  return DENIED_RULES.find((r) => r.test(segs))?.rule ?? null;
}

/**
 * The rule a path the console asks to read or list breaks, or null. A folder is also judged by
 * what it would contain: listing `.ssh` or `.git` is refused, though `deniedRule` only sees those
 * from a path beneath them.
 */
export function deniedStationPath(rel: string): string | null {
  const trimmed = rel.replace(/[\\/]+$/, "");
  return deniedRule(trimmed) ?? deniedRule(`${trimmed}/x`);
}
