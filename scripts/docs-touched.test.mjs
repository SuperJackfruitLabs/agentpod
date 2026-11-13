// node --test scripts/docs-touched.test.mjs
// Each case is a pull request the check must pass or fail, so reverting a rule in
// docs-touched.mjs turns one of these red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LABEL, verdict } from './docs-touched.mjs';

const route = 'apps/hub/src/routes/station-timeline.ts';

void test('a route change with no docs fails', () => {
  assert.equal(verdict({ files: [route], labels: [] }).ok, false);
});

void test('a route change with a docs-site page passes', () => {
  assert.equal(verdict({ files: [route, 'docs-site/src/content/docs/use/panels.md'], labels: [] }).ok, true);
});

void test('a route change with a runbook or a README passes', () => {
  assert.equal(verdict({ files: [route, 'docs/OPERATING.md'], labels: [] }).ok, true);
  assert.equal(verdict({ files: [route, 'apps/hub/README.md'], labels: [] }).ok, true);
});

void test('the label excuses it', () => {
  assert.equal(verdict({ files: [route], labels: ['ci', LABEL] }).ok, true);
});

void test('another label does not', () => {
  assert.equal(verdict({ files: [route], labels: ['documentation'] }).ok, false);
});

void test('adding to the undocumented baseline is not documenting', () => {
  assert.equal(verdict({ files: [route, 'docs/undocumented-baseline.json'], labels: [] }).ok, false);
});

void test('each kind of surface counts', () => {
  for (const file of [
    'apps/hub/src/index.ts',
    'apps/hub/src/config.ts',
    'apps/hub/src/mcp/tools.ts',
    'apps/hub/src/services/bridge/push-subscription.ts',
    'apps/hub/.env.example',
    'packages/contract/src/gateway.ts',
    'apps/node-agent/cmd/agentpod-fleet/fleet.go',
    'apps/node-agent/internal/nodecli/reference.go',
  ])
    assert.equal(verdict({ files: [file], labels: [] }).ok, false, file);
});

void test('tests and other code are not surface', () => {
  for (const file of [
    'apps/hub/src/routes/station-timeline.test.ts',
    'apps/node-agent/cmd/agentpod-fleet/fleet_test.go',
    'apps/hub/src/services/bridge/loop.ts',
    'apps/console/src/routes/+page.svelte',
  ])
    assert.equal(verdict({ files: [file], labels: [] }).ok, true, file);
});

void test('the command line exits 1 on a failing dry run and 0 on a passing one', () => {
  const script = fileURLToPath(new URL('./docs-touched.mjs', import.meta.url));
  const run = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8' }).status;
  assert.equal(run('--files', route, '--labels', ''), 1);
  assert.equal(run('--files', `${route},docs/OPERATING.md`), 0);
  assert.equal(run('--files', route, '--labels', LABEL), 0);
});
