#!/usr/bin/env node
// Docs touched? A pull request that changes the public surface must change the docs too, or say
// why not with the `no-docs-needed` label. Run by .github/workflows/docs-touched.yml.
//
// The surface is what another product or an operator reads: the hub's routes, settings and MCP
// tools, the bridge's push subscriptions, the wire contract (events and messages), and the two
// CLIs. The docs are docs-site/, docs/ and any README. docs/undocumented-baseline.json does not
// count: adding a new route to the list of undocumented ones is not documenting it.
//
// The completeness ratchet (apps/hub/tests/unit/docs-claims.test.ts) says WHAT is undocumented;
// this says a change to the surface was looked at by someone writing docs. Neither replaces the
// other: the ratchet cannot see a changed meaning, and this cannot see a missing name.
//
//   BASE_SHA=<sha> HEAD_SHA=<sha> PR_LABELS='["a","b"]' node scripts/docs-touched.mjs
//   node scripts/docs-touched.mjs --files a.ts,docs/x.md --labels no-docs-needed   (dry run)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LABEL = 'no-docs-needed';

/** Files whose change can change the public surface. Tests never do. */
const SURFACE = [
  /^apps\/hub\/src\/index\.ts$/,
  /^apps\/hub\/src\/routes\//,
  /^apps\/hub\/src\/(config|validate-config)\.ts$/,
  /^apps\/hub\/src\/mcp\/tools\.ts$/,
  /^apps\/hub\/src\/services\/bridge\/push-subscription\.ts$/,
  /^apps\/hub\/\.env\.example$/,
  /^packages\/contract\/src\//,
  /^apps\/node-agent\/cmd\/agentpod-(fleet|node)\//,
  /^apps\/node-agent\/internal\/(fleetcli|nodecli)\//,
];
const TEST = /(\.test\.|\.spec\.|_test\.go$|\/__tests__\/)/;

const DOCS = [/^docs-site\//, /^docs\//, /(^|\/)README\.md$/];
const NOT_DOCS = new Set(['docs/undocumented-baseline.json']);

export const isSurface = (file) => SURFACE.some((re) => re.test(file)) && !TEST.test(file);
export const isDocs = (file) => DOCS.some((re) => re.test(file)) && !NOT_DOCS.has(file);

/** The verdict for one pull request: its changed files and its labels. */
export function verdict({ files, labels }) {
  const surface = files.filter(isSurface);
  const docs = files.filter(isDocs);
  if (surface.length === 0) return { ok: true, reason: 'no public-surface file changed', surface, docs };
  if (docs.length > 0) return { ok: true, reason: 'the docs changed too', surface, docs };
  if (labels.includes(LABEL)) return { ok: true, reason: `labelled ${LABEL}`, surface, docs };
  return {
    ok: false,
    reason: `public-surface files changed and no docs did. Update docs-site/, docs/ or a README, or add the ${LABEL} label if nothing a reader sees changed.`,
    surface,
    docs,
  };
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : (process.argv[i + 1] ?? '');
}

function list(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function args() {
  const files = flag('--files');
  const labels = flag('--labels');
  if (files !== undefined) return { files: list(files), labels: list(labels ?? '') };

  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA ?? 'HEAD';
  if (!base) throw new Error('BASE_SHA is required (or pass --files for a dry run)');
  const diff = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
  const parsed = JSON.parse(process.env.PR_LABELS || '[]');
  return { files: list(diff.replaceAll('\n', ',')), labels: Array.isArray(parsed) ? parsed.map(String) : [] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verdict(args());
  for (const f of result.surface) console.log(`surface: ${f}`);
  for (const f of result.docs) console.log(`docs:    ${f}`);
  console.log(`${result.ok ? 'ok' : 'FAIL'}: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}
