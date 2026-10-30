#!/usr/bin/env node
// Writes a short prose summary of a release for its notes, from material passed in: the
// changelog section, the commit subjects and the diff stat. Provider-neutral: any
// OpenAI-compatible /chat/completions endpoint (default: Claude Sonnet through Anthropic's
// OpenAI-compatible API).
//
// It never blocks a release. On any failure it writes nothing to --out, prints one line
// saying why, and exits 0, so the release ships with the rest of its notes.
//
// Usage: summarise.mjs --product Salaam --version v0.0.4 --changelog f --log f --stat f --out f
// Env:   RELEASE_SUMMARY_API_KEY (secret), RELEASE_SUMMARY_BASE_URL, RELEASE_SUMMARY_MODEL,
//        RELEASE_SUMMARY_TIMEOUT_MS
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const LIMIT = 60_000; // characters of material per input, so a huge release stays in budget

export const SYSTEM = [
  'You write the summary at the top of a software release note.',
  'Write two or three short prose paragraphs, under 400 words in all. No headings, no bullet',
  'points, no lists. Lead with the highlights a person wrote in the changelog, if any. Then',
  'the main themes of the change. Then anything an operator must do before or after',
  'upgrading. Then what users will notice. Use only the material given: never guess, never',
  'invent a feature, number or reason that is not in it. If the material is thin, say less.',
  'Plain words. Do not mention commit hashes or pull request numbers.',
].join(' ');

export function prompt({ product, version, changelog, log, stat }) {
  const cut = (s) => (s.length > LIMIT ? s.slice(0, LIMIT) + '\n[truncated]' : s);
  return [
    `Release: ${product} ${version}`,
    '',
    'Changelog section (written by a person; may be empty):',
    cut(changelog.trim()) || '(none)',
    '',
    'Commit subjects since the previous release:',
    cut(log.trim()) || '(none)',
    '',
    'Diff stat:',
    cut(stat.trim()) || '(none)',
  ].join('\n');
}

/** The summary text, or null with a reason. Never throws. */
export async function summarise(material, opts = {}) {
  const key = opts.key ?? process.env.RELEASE_SUMMARY_API_KEY;
  const base = opts.baseUrl ?? process.env.RELEASE_SUMMARY_BASE_URL ?? DEFAULT_BASE_URL;
  const model = opts.model ?? process.env.RELEASE_SUMMARY_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = Number(opts.timeoutMs ?? process.env.RELEASE_SUMMARY_TIMEOUT_MS ?? 60_000);
  if (!key) return { text: null, reason: 'no RELEASE_SUMMARY_API_KEY set' };
  const url = base.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      // No temperature or top_p: current Claude models reject non-default values.
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt(material) },
        ],
      }),
    });
    if (!res.ok) return { text: null, reason: `summary endpoint answered HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim())
      return { text: null, reason: 'summary endpoint returned no text' };
    return { text: text.trim(), reason: null };
  } catch (error) {
    return {
      text: null,
      reason:
        error?.name === 'AbortError'
          ? `summary timed out after ${timeoutMs} ms`
          : 'summary request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}
const read = (path) => {
  try {
    return path ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
};

async function main() {
  const a = args(process.argv.slice(2));
  const { text, reason } = await summarise({
    product: a.product ?? 'Release',
    version: a.version ?? '',
    changelog: read(a.changelog),
    log: read(a.log),
    stat: read(a.stat),
  });
  if (a.out) writeFileSync(a.out, text ?? '');
  console.log(text ? 'summary written' : `no summary: ${reason}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch(() => console.log('no summary: unexpected error'));
