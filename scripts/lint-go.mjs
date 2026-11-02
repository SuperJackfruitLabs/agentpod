#!/usr/bin/env node
// golangci-lint over apps/node-agent with a ratchet (docs/contributor/code-quality.md).
//
// Findings are counted per linter in scripts/lint-go-baseline.json, the same way as the
// TypeScript ratchet in scripts/lint.mjs: a count may fall but never rise, a linter missing
// from the baseline must be clean, and an improvement must be locked in with
// `pnpm lint:go --update`.
//
// The linter is pinned. Install that exact version once (never @latest):
//   GOBIN="$PWD/.bin" go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
// The script uses $GOLANGCI_LINT, then .bin/golangci-lint, then golangci-lint on PATH, and
// refuses any other version: a newer linter finds more, and the counts would mean nothing.
//
// It always analyses the linux/amd64 build, which is what CI runs and what most of the fleet
// runs; on a Mac the darwin-only files would otherwise change the counts.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2.15.0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleDir = join(root, 'apps/node-agent');
const baselinePath = join(root, 'scripts/lint-go-baseline.json');
const update = process.argv.includes('--update');

const local = join(root, '.bin/golangci-lint');
const bin = process.env.GOLANGCI_LINT || (existsSync(local) ? local : 'golangci-lint');
const env = { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' };

const version = spawnSync(bin, ['version', '--short'], { encoding: 'utf8', env });
if (version.error || version.stdout.trim().replace(/^v/, '') !== VERSION) {
  console.error(
    `lint:go needs golangci-lint ${VERSION} (found ${version.error ? 'none' : version.stdout.trim()}).\n` +
      `  GOBIN="$PWD/.bin" go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v${VERSION}`,
  );
  process.exit(2);
}

const run = spawnSync(
  bin,
  ['run', '--output.json.path=stdout', '--output.text.path=stderr', '--show-stats=false', './...'],
  { cwd: moduleDir, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 },
);
if (run.error) throw run.error;
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  process.stderr.write(run.stderr || run.stdout);
  process.exit(2);
}
// Exit 1 means "issues found"; anything else is the linter failing to run.
if (run.status !== 0 && run.status !== 1) {
  process.stderr.write(run.stderr);
  process.exit(2);
}

const findings = report.Issues ?? [];
const counts = {};
for (const f of findings) counts[f.FromLinter] = (counts[f.FromLinter] ?? 0) + 1;
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

const raised = Object.entries(counts).filter(([linter, n]) => n > (baseline[linter] ?? 0));
if (raised.length) {
  for (const [linter, n] of raised) {
    console.error(`${linter}: ${n} findings, the baseline allows ${baseline[linter] ?? 0}`);
    for (const f of findings.filter((x) => x.FromLinter === linter).slice(0, 20))
      console.error(`  apps/node-agent/${f.Pos.Filename}:${f.Pos.Line}  ${f.Text}`);
  }
  process.exit(1);
}

const lowered = Object.keys(baseline).filter((linter) => (counts[linter] ?? 0) < baseline[linter]);
if (update) {
  const next = Object.fromEntries(Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(`lint:go baseline: ${findings.length} findings across ${Object.keys(next).length} linters`);
} else if (lowered.length) {
  console.error(`lint:go: ${lowered.join(', ')} improved; run pnpm lint:go --update to lock it in`);
  process.exit(1);
} else {
  console.log(`lint:go: ok (${findings.length} findings held by the baseline)`);
}
