// node --test scripts/ci-plan.test.mjs
//
// The docs-only CI plan (scripts/ci-plan.mjs, .github/workflows/ci.yml): the classifier fails
// closed, and the `check` aggregate passes only for the graph its plan selected.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JOBS, aggregate, classify, gitIn, isDocsPath, planFor } from './ci-plan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/ci-plan.mjs');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A git that answers merge-base with SHA_A and the diff with `paths`. */
const fakeGit = (paths) => (args) =>
  args[0] === 'merge-base' ? { ok: true, stdout: `${SHA_A}\n` } : { ok: true, stdout: paths.map((p) => `${p}\0`).join('') };
const noMergeBase = (args) => (args[0] === 'merge-base' ? { ok: false, error: 'exit 1' } : { ok: true, stdout: 'README.md\0' });
const blankMergeBase = (args) => (args[0] === 'merge-base' ? { ok: true, stdout: '\n' } : { ok: true, stdout: 'README.md\0' });
const failedDiff = (args) => (args[0] === 'merge-base' ? { ok: true, stdout: SHA_A } : { ok: false, error: 'spawnSync git ENOBUFS' });
const throwingGit = () => {
  throw new Error('boom');
};
const pr = (git, base = SHA_A, head = SHA_B) => planFor({ event: 'pull_request', base, head, git });
const cli = (args, env) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

void describe('classifier', () => {
  for (const [name, paths] of [
    ['README.md only', ['README.md']],
    ['bare README', ['README']],
    ['README + docs/** + docs-site/**', ['README', 'docs/OPERATING.md', 'docs/undocumented-baseline.json', 'docs-site/src/content/docs/reference/fleet.md']],
  ]) {
    void test(`docs-only: ${String(name)}`, () => assert.equal(pr(fakeGit(paths)).docsOnly, true));
  }

  for (const [name, paths] of [
    ['docs + application source', ['docs/OPERATING.md', 'apps/hub/src/index.ts']],
    ['docs-site + console source', ['docs-site/src/content/docs/use/boards.md', 'apps/console/src/routes/+page.svelte']],
    ['workflow', ['.github/workflows/ci.yml']],
    ['release config', ['.github/release-config.json']],
    ['the planner itself', ['scripts/ci-plan.mjs']],
    ['root package', ['package.json']],
    ['root lock', ['pnpm-lock.yaml']],
    ['docs-site lock', ['docs-site/package-lock.json', 'pnpm-lock.yaml']],
    ['contract schema', ['packages/contract/src/index.ts']],
    ['generated product artifact (Go fixtures)', ['packages/contract/fixtures/go/frames.json']],
    ['landing', ['apps/landing/src/pages/index.astro']],
    ['unknown path', ['CHANGELOG.md']],
    ['agent notes', ['CLAUDE.md']],
    ['README below another directory', ['apps/hub/README.md']],
    ['README lookalike', ['READMEx.md']],
    ['case differs', ['readme.md']],
    ['Docs/ is not docs/', ['Docs/OPERATING.md']],
    ['a file named docs', ['docs']],
    ['the docs/ prefix alone', ['docs/']],
    ['docs-siteX/ is not docs-site/', ['docs-siteX/a.md']],
    ['a README.* that is a directory', ['README.d/x.md']],
  ]) {
    void test(`not docs-only: ${String(name)}`, () => assert.equal(pr(fakeGit(paths)).docsOnly, false));
  }

  void test('an empty diff is not docs-only', () => {
    assert.deepEqual(pr(fakeGit([])), { docsOnly: false, reason: 'the diff is empty' });
    assert.equal(classify([]).docsOnly, false);
  });

  for (const [name, base, head] of [
    ['empty base', '', SHA_B],
    ['zero base', '0'.repeat(40), SHA_B],
    ['empty head', SHA_A, ''],
    ['short sha', 'abc123', SHA_B],
  ]) {
    void test(`an unavailable sha is not docs-only: ${name}`, () => {
      const plan = pr(fakeGit(['README.md']), base, head);
      assert.equal(plan.docsOnly, false);
      assert.match(plan.reason, /unavailable/);
    });
  }

  void test('a missing merge base is not docs-only', () => {
    assert.deepEqual(pr(noMergeBase), { docsOnly: false, reason: 'no merge base: exit 1' });
    assert.equal(pr(blankMergeBase).docsOnly, false);
  });

  void test('a failed or overflowing diff is not docs-only', () => {
    assert.deepEqual(pr(failedDiff), { docsOnly: false, reason: 'the diff failed: spawnSync git ENOBUFS' });
  });

  void test('a classifier error is not docs-only', () => {
    assert.deepEqual(pr(throwingGit), { docsOnly: false, reason: 'the classifier failed: boom' });
  });

  for (const event of ['push', 'schedule', 'workflow_dispatch', 'workflow_call', 'pull_request_target', 'merge_group', '']) {
    void test(`the ${event || 'empty'} event is never docs-only, even for a docs-only diff`, () => {
      assert.equal(planFor({ event, base: SHA_A, head: SHA_B, git: fakeGit(['README.md']) }).docsOnly, false);
    });
  }

  void test('isDocsPath matches only the three families', () => {
    assert.ok(['README', 'README.md', 'README.de.md', 'docs/a', 'docs-site/a/b'].every(isDocsPath));
    assert.ok(!['README/', 'apps/README.md', 'docs', 'docs-site', 'xdocs/a', '.docs/a'].some(isDocsPath));
  });
});

void describe('classifier against a real repository', () => {
  let dir = '';
  let base = '';
  const sh = (...args) => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message) => {
    sh('add', '-A');
    sh('commit', '-q', '-m', message);
    return sh('rev-parse', 'HEAD');
  };
  const branch = (name, change) => {
    sh('checkout', '-q', '-B', name, base);
    change();
    return commit(name);
  };
  const plan = (head, from = base) => planFor({ event: 'pull_request', base: from, head, git: gitIn(dir) });

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-plan-'));
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 'ci@example.invalid');
    sh('config', 'user.name', 'ci');
    sh('config', 'commit.gpgsign', 'false');
    write('README.md', 'readme\n');
    write('docs/guide.md', 'guide\n');
    write('apps/hub/src/app.ts', 'export {};\n');
    base = commit('base');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  void test('a docs-only branch is docs-only', () => {
    const head = branch('docs', () => {
      write('README.md', 'readme, edited\n');
      write('docs/new page.md', 'a path with a space\n');
      write('docs-site/index.md', 'site\n');
    });
    assert.deepEqual(plan(head), { docsOnly: true, reason: 'all 3 changed paths are docs' });
  });

  void test('a rename from docs/ to source is not docs-only', () => {
    const head = branch('rename', () => renameSync(join(dir, 'docs/guide.md'), join(dir, 'apps/hub/src/guide.ts')));
    assert.equal(plan(head).docsOnly, false);
  });

  void test('a move from source into docs/ is not docs-only (the old path counts)', () => {
    const head = branch('rename-in', () => renameSync(join(dir, 'apps/hub/src/app.ts'), join(dir, 'docs/app.ts')));
    assert.deepEqual(plan(head), { docsOnly: false, reason: 'apps/hub/src/app.ts is not a docs path' });
  });

  void test('a rename within docs/ stays docs-only', () => {
    const head = branch('rename-docs', () => renameSync(join(dir, 'docs/guide.md'), join(dir, 'docs/moved.md')));
    assert.equal(plan(head).docsOnly, true);
  });

  void test('a large docs-only diff is read whole', () => {
    const head = branch('large', () => {
      for (let i = 0; i < 4000; i++) write(`docs/bulk/page-${i}.md`, `${i}\n`);
    });
    assert.deepEqual(plan(head), { docsOnly: true, reason: 'all 4000 changed paths are docs' });
    const mixed = branch('large-mixed', () => {
      for (let i = 0; i < 4000; i++) write(`docs/bulk/page-${i}.md`, `${i}\n`);
      write('zz-last.ts', 'export {};\n');
    });
    assert.equal(plan(mixed).docsOnly, false);
  });

  void test('a commit with no changes is not docs-only', () => {
    sh('checkout', '-q', '-B', 'empty', base);
    sh('commit', '-q', '--allow-empty', '-m', 'empty');
    assert.deepEqual(plan(sh('rev-parse', 'HEAD')), { docsOnly: false, reason: 'the diff is empty' });
  });

  void test('a base that is not in the clone is not docs-only', () => {
    const head = branch('docs-2', () => write('README.md', 'again\n'));
    assert.match(plan(head, 'c'.repeat(40)).reason, /^no merge base/);
  });

  void test('unrelated histories (no merge base) are not docs-only', () => {
    sh('checkout', '-q', '--orphan', 'orphan');
    sh('rm', '-rqf', '.');
    write('README.md', 'orphan\n');
    assert.match(plan(commit('orphan')).reason, /^no merge base/);
  });
});

/** Every result GitHub gives a job in `needs`, and a job missing from it. */
const RESULTS = ['success', 'failure', 'skipped', 'cancelled', 'missing'];

/** A needs context: `plan` is the changes job's outputs, `results` each judged job's result. */
function needsFor(changes, plan, results) {
  const needs = {};
  if (changes !== 'missing') needs.changes = { result: changes, outputs: plan };
  for (const [name, result] of Object.entries(results)) if (result !== 'missing') needs[name] = { result, outputs: {} };
  return needs;
}

const PLANS = {
  docsOnly: { app: 'false', landing: 'false', docs: 'true', docs_only: 'true' },
  full: { app: 'true', landing: 'true', docs: 'false', docs_only: 'false' },
  fullWithDocs: { app: 'true', landing: 'true', docs: 'true', docs_only: 'false' },
  landingOnly: { app: 'false', landing: 'true', docs: 'false', docs_only: 'false' },
};

/** What each judged job must report under a plan. */
const expected = (plan) =>
  Object.fromEntries(Object.entries(JOBS).map(([name, output]) => [name, plan[output] === 'true' ? 'success' : 'skipped']));

void describe('aggregate truth table', () => {
  // For each plan, the planned graph passes; then each job in turn is set to every other result
  // (including missing) and must fail. The classifier's own result is varied the same way.
  for (const event of ['pull_request', 'push']) {
    for (const [planName, plan] of Object.entries(PLANS)) {
      const valid = !(planName === 'docsOnly' && event !== 'pull_request');
      void test(`${event} ${planName}: the planned graph ${valid ? 'passes' : 'fails (push cannot be docs-only)'}`, () => {
        assert.equal(aggregate(needsFor('success', plan, expected(plan)), event).ok, valid);
      });
      for (const changes of RESULTS.filter((r) => r !== 'success')) {
        void test(`${event} ${planName}: changes=${changes} fails`, () => {
          assert.equal(aggregate(needsFor(changes, plan, expected(plan)), event).ok, false);
        });
      }
      for (const job of Object.keys(JOBS)) {
        for (const result of RESULTS.filter((r) => r !== expected(plan)[job])) {
          void test(`${event} ${planName}: ${job}=${result} fails`, () => {
            assert.equal(aggregate(needsFor('success', plan, { ...expected(plan), [job]: result }), event).ok, false);
          });
        }
      }
    }
  }

  void test('a known failing docs fixture fails the docs-only run', () => {
    for (const job of ['docs-site', 'docs-claims', 'docs-reference']) {
      const verdict = aggregate(needsFor('success', PLANS.docsOnly, { ...expected(PLANS.docsOnly), [job]: 'failure' }), 'pull_request');
      assert.deepEqual(verdict, { ok: false, reason: `${job} is failure, the plan expects success` });
    }
  });

  void test('an unreadable plan output fails', () => {
    for (const name of ['app', 'landing', 'docs', 'docs_only']) {
      for (const value of ['', 'yes', undefined]) {
        const plan = { ...PLANS.full, [name]: value };
        if (value === undefined) delete plan[name];
        assert.equal(aggregate(needsFor('success', plan, expected(PLANS.full)), 'pull_request').ok, false, `${name}=${value}`);
      }
    }
  });

  void test('a docs-only plan that also selects other work fails', () => {
    for (const extra of [{ app: 'true' }, { landing: 'true' }, { docs: 'false' }]) {
      const plan = { ...PLANS.docsOnly, ...extra };
      assert.equal(aggregate(needsFor('success', plan, expected(plan)), 'pull_request').ok, false, JSON.stringify(extra));
    }
  });

  void test('an unreadable needs context fails', () => {
    for (const needs of [undefined, null, '{}']) assert.equal(aggregate(needs, 'pull_request').ok, false);
  });
});

void describe('the CLI', () => {
  void test('aggregate exits 0 only for a passing graph, and 1 for unparseable needs', () => {
    const ok = cli(['aggregate'], { EVENT: 'pull_request', NEEDS: JSON.stringify(needsFor('success', PLANS.docsOnly, expected(PLANS.docsOnly))) });
    assert.equal(ok.status, 0, ok.stdout);
    const bad = cli(['aggregate'], { EVENT: 'pull_request', NEEDS: JSON.stringify(needsFor('success', PLANS.docsOnly, { ...expected(PLANS.docsOnly), hub: 'success' })) });
    assert.equal(bad.status, 1);
    assert.equal(cli(['aggregate'], { EVENT: 'push', NEEDS: 'not json' }).status, 1);
  });

  void test('plan writes docs_only=false for a push, to GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-plan-out-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    assert.equal(cli(['plan'], { EVENT: 'push', GITHUB_OUTPUT: out }).status, 0);
    assert.equal(readFileSync(out, 'utf8'), 'docs_only=false\nreason=push keeps its plan\n');
    rmSync(dir, { recursive: true, force: true });
  });

  void test('an unknown command exits 2', () => assert.equal(cli(['nope'], {}).status, 2));
});

/** The `changes` shell plan before docs-only routing, for each event and filter set. */
const preChangePlan = ({ EVENT, APP, WORKFLOWS, LANDING, DOCS }) => {
  const app = !['push', 'pull_request'].includes(EVENT) || APP === 'true' || WORKFLOWS === 'true';
  const landing = app || LANDING === 'true';
  const docs = DOCS === 'true' || WORKFLOWS === 'true' || !['push', 'pull_request'].includes(EVENT);
  return { app: String(app), landing: String(landing), docs: String(docs), docs_only: 'false' };
};

void describe('the workflow keeps its contract', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const job = (name) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    assert.ok(start > -1, `job ${name} is missing`);
    const rest = ci.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };

  /** The shell planner in `changes`, run as the workflow would with the given filter outputs. */
  const shellPlan = (env) => {
    const block = /- id: plan\n(?: {8}.*\n)*? {8}run: \|\n((?: {10}.*\n)+)/.exec(job('changes'));
    assert.ok(block, 'the plan step is missing');
    const script = block[1].split('\n').map((line) => line.slice(10)).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'ci-plan-shell-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    try {
      const run = spawnSync('sh', ['-eu', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, ...env } });
      assert.equal(run.status, 0, run.stderr);
      return Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map((line) => line.split('=')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const filters = { APP: 'true', WORKFLOWS: 'false', LANDING: 'false', DOCS: 'false' };

  void test('the events are unchanged', () => {
    assert.ok(
      ci.startsWith(
        'name: CI\n\non:\n  push:\n    branches: [main, develop, redesign/fleet-console]\n  pull_request:\n    branches: [main, develop, redesign/fleet-console]\n',
      ),
    );
    assert.match(ci, /\n {2}workflow_dispatch:\n\nconcurrency:/);
  });

  void test('every job check judges still exists under its own name, gated by its plan output', () => {
    for (const [name, output] of Object.entries(JOBS)) {
      const body = job(name);
      assert.match(body, new RegExp(`^  ${name}:\\n    name: ${name}\\n`), `${name} was renamed`);
      assert.ok(body.includes(`    needs: [changes]\n    if: needs.changes.outputs.${output} == 'true'\n`), `${name} is not gated by ${output}`);
    }
  });

  void test('check runs unless cancelled and judges every planned job', () => {
    const body = job('check');
    assert.ok(body.includes(`    needs: [changes, ${Object.keys(JOBS).join(', ')}]\n    if: \${{ !cancelled() }}\n`));
    assert.ok(body.includes('run: node scripts/ci-plan.mjs aggregate'));
  });

  void test('the classifier reads the pull request shas from a full clone and cannot fail the plan', () => {
    const body = job('changes');
    assert.ok(body.includes('fetch-depth: 0'));
    assert.ok(body.includes('        id: docs\n        continue-on-error: true\n'));
    assert.ok(body.includes('BASE_SHA: ${{ github.event.pull_request.base.sha }}'));
    assert.ok(body.includes('HEAD_SHA: ${{ github.event.pull_request.head.sha }}'));
    assert.ok(body.includes('DOCS_ONLY: ${{ steps.docs.outputs.docs_only }}'));
  });

  void test('a docs-only pull request runs only the docs lane', () => {
    assert.deepEqual(shellPlan({ ...filters, EVENT: 'pull_request', DOCS_ONLY: 'true' }), { app: 'false', landing: 'false', docs: 'true', docs_only: 'true' });
  });

  void test('without docs-only the shell plan is what it was before', () => {
    const bools = ['true', 'false'];
    for (const EVENT of ['pull_request', 'push', 'workflow_dispatch']) {
      for (const APP of bools) for (const WORKFLOWS of bools) for (const LANDING of bools) for (const DOCS of bools) {
        for (const DOCS_ONLY of ['false', '', 'TRUE', ...(EVENT === 'pull_request' ? [] : ['true'])]) {
          const env = { EVENT, APP, WORKFLOWS, LANDING, DOCS, DOCS_ONLY };
          assert.deepEqual(shellPlan(env), preChangePlan(env), JSON.stringify(env));
        }
      }
    }
  });

  void test('the docs lane runs the same commands the app jobs run', () => {
    assert.ok(job('hub').includes('        working-directory: apps/hub\n        run: bun test\n'));
    assert.ok(job('docs-claims').includes('        working-directory: apps/hub\n        run: bun test tests/unit/docs-claims.test.ts\n'));
    assert.ok(job('node-agent').includes('        working-directory: apps/node-agent\n        run: go test ./... -race\n'));
    assert.ok(job('docs-reference').includes('        working-directory: apps/node-agent\n        run: go test ./cmd/agentpod-fleet ./cmd/agentpod-node -race\n'));
  });

  void test('the deploys are untouched: push to main only', () => {
    assert.ok(job('deploy-hub-staging').includes("    if: needs.changes.outputs.app == 'true' && github.ref == 'refs/heads/main' && github.event_name == 'push'\n"));
    for (const name of ['deploy-docs', 'deploy-landing']) {
      assert.ok(job(name).includes("    if: github.ref == 'refs/heads/main' && github.event_name == 'push'\n"), name);
    }
  });
});
