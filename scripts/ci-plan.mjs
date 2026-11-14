#!/usr/bin/env node
// The docs-only part of the CI plan for .github/workflows/ci.yml, and the run's verdict.
//
//   node scripts/ci-plan.mjs plan       in `changes`: writes docs_only=true|false (and reason)
//   node scripts/ci-plan.mjs aggregate  the `check` job: exits non-zero unless every job in the
//                                       run ended the way the plan in `changes` selected
//
// A pull request is docs-only when every path it changes is a root README / README.*, or sits
// under docs/ or docs-site/. Then the application and landing jobs are skipped and only the docs
// lane runs: the docs-site build, the docs-claims test and the CLI reference-page tests. Anything
// else (any other path, a mixed change, an empty diff, a missing merge base, a failed diff, an
// error, any event but pull_request) keeps the plan `changes` already made. A doubt is never
// docs-only.
//
// Only node: imports, so both commands run without an install.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_README = /^README(\.[^/]+)?$/;
const DOCS_TREES = ['docs/', 'docs-site/'];

/** A repository-root-relative path in the docs allowlist. Case-sensitive. */
export function isDocsPath(path) {
  if (ROOT_README.test(path)) return true;
  return DOCS_TREES.some((tree) => path.startsWith(tree) && path.length > tree.length);
}

/** The plan for a complete changed-path set. An empty set is never docs-only. */
export function classify(paths) {
  if (paths.length === 0) return { docsOnly: false, reason: 'the diff is empty' };
  const other = paths.find((path) => !isDocsPath(path));
  if (other !== undefined) return { docsOnly: false, reason: `${other} is not a docs path` };
  return { docsOnly: true, reason: `all ${paths.length} changed paths are docs` };
}

/** Runs git in `cwd`. A non-zero exit, a signal or an overflowing buffer is a failure. */
export function gitIn(cwd) {
  return (args) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (run.error) return { ok: false, error: run.error.message };
    if (run.status !== 0) {
      return { ok: false, error: `git ${args[0]} exited ${run.status ?? run.signal}: ${run.stderr.trim()}` };
    }
    return { ok: true, stdout: run.stdout };
  };
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Every path a pull request changes, from the merge base of base and head to head. Renames are
 * off, so a move reports both its old and its new path. An error when the set cannot be read whole.
 */
export function changedPaths(git, base, head) {
  for (const [name, sha] of [['base', base], ['head', head]]) {
    if (!SHA.test(sha) || /^0+$/.test(sha)) return { error: `the ${name} sha is unavailable (${sha || 'empty'})` };
  }
  const mergeBase = git(['merge-base', base, head]);
  if (!mergeBase.ok) return { error: `no merge base: ${mergeBase.error}` };
  const from = mergeBase.stdout.trim();
  if (!SHA.test(from)) return { error: `no merge base: git printed ${JSON.stringify(from)}` };
  const diff = git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', from, head, '--']);
  if (!diff.ok) return { error: `the diff failed: ${diff.error}` };
  return { paths: diff.stdout.split('\0').filter((path) => path !== '') };
}

/** Whether a run is docs-only. Only a pull_request can be; every doubt is not. */
export function planFor({ event, base, head, git }) {
  if (event !== 'pull_request') return { docsOnly: false, reason: `${event || 'an unknown event'} keeps its plan` };
  try {
    const changed = changedPaths(git, base, head);
    if ('error' in changed) return { docsOnly: false, reason: changed.error };
    return classify(changed.paths);
  } catch (error) {
    return { docsOnly: false, reason: `the classifier failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Which plan output selects each job `check` judges. */
export const JOBS = {
  contract: 'app',
  hub: 'app',
  'node-agent': 'app',
  'lint-ts': 'app',
  'lint-go': 'app',
  console: 'app',
  worker: 'app',
  'docs-site': 'docs',
  'docs-claims': 'docs_only',
  'docs-reference': 'docs_only',
  landing: 'landing',
};

const OUTPUTS = ['app', 'landing', 'docs', 'docs_only'];

/**
 * Whether a run passed, from the `needs` context of the `check` job. The `changes` job must have
 * succeeded with a readable plan; then every judged job must have succeeded if the plan selected
 * it and been skipped if not. A docs-only plan must be a pull request that selects the docs lane
 * and nothing else. A missing job, a failure, a cancel, an unplanned skip or run, or an
 * unreadable plan fails it.
 */
export function aggregate(needs, event) {
  if (typeof needs !== 'object' || needs === null) return { ok: false, reason: 'the needs context is unreadable' };
  const changes = field(needs, 'changes');
  if (changes === undefined) return { ok: false, reason: 'the changes job is missing' };
  const changesResult = field(changes, 'result');
  if (changesResult !== 'success') return { ok: false, reason: `the changes job is ${String(changesResult)}` };
  const plan = {};
  for (const name of OUTPUTS) {
    const value = field(field(changes, 'outputs'), name);
    if (value !== 'true' && value !== 'false') return { ok: false, reason: `the plan is unreadable (${name}=${String(value)})` };
    plan[name] = value === 'true';
  }
  if (plan.docs_only) {
    if (event !== 'pull_request') return { ok: false, reason: `a ${event || 'run with no event'} cannot be docs-only` };
    if (plan.app || plan.landing || !plan.docs) return { ok: false, reason: 'a docs-only plan must select the docs lane and nothing else' };
  }
  for (const [name, output] of Object.entries(JOBS)) {
    const job = field(needs, name);
    if (job === undefined) return { ok: false, reason: `the ${name} job is missing` };
    const expected = plan[output] ? 'success' : 'skipped';
    const result = field(job, 'result');
    if (result !== expected) return { ok: false, reason: `${name} is ${String(result)}, the plan expects ${expected}` };
  }
  return plan.docs_only
    ? { ok: true, reason: 'docs-only: the docs lane passed and every other job was skipped as planned' }
    : { ok: true, reason: 'every planned job passed and every other job was skipped as planned' };
}

/** An own property of an object read from JSON, or undefined. */
function field(value, key) {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
  return value[key];
}

function main(command) {
  const env = process.env;
  if (command === 'plan') {
    const plan = planFor({ event: env.EVENT ?? '', base: env.BASE_SHA ?? '', head: env.HEAD_SHA ?? '', git: gitIn(process.cwd()) });
    const lines = `docs_only=${plan.docsOnly}\nreason=${plan.reason.replace(/[\r\n]+/g, ' ')}\n`;
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
    process.stdout.write(lines);
    return 0;
  }
  if (command === 'aggregate') {
    let needs;
    try {
      needs = JSON.parse(env.NEEDS ?? '');
    } catch {
      needs = undefined;
    }
    const verdict = aggregate(needs, env.EVENT ?? '');
    process.stdout.write(`${verdict.ok ? 'pass' : 'fail'}: ${verdict.reason}\n`);
    return verdict.ok ? 0 : 1;
  }
  process.stderr.write('usage: node scripts/ci-plan.mjs plan|aggregate\n');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
