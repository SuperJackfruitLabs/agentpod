/**
 * Redaction of session content before it leaves the hub as evidence.
 *
 * Applied to every string of every transcript item AFTER folding — so a secret an agent streamed
 * in two chunks is one string by the time a rule looks at it — and never to what is stored:
 * `acp_events` keeps the original text, because it is the record.
 *
 * Rules run in this order, and each hit becomes `[redacted:<rule-name>]`:
 *   1. the exact values of this hub's own secrets (12+ characters, so a short value cannot
 *      redact ordinary words);
 *   2. credential patterns, each named in its marker: anthropic-key, openai-key, aws-access-key,
 *      github-token, slack-token, stripe-key, google-api-key, jwt, private-key, authorization,
 *      url-credentials (with or without a user), service-credential, superpipeline-key,
 *      query-secret, and env-assignment (`AWS_SECRET_ACCESS_KEY=…`, the name kept);
 *   3. key names (`key-name`): in an object, the WHOLE value of a key that names a credential —
 *      `db_password`, `X-Api-Key`, `aws_secret_access_key`, and camelCase `accessToken`,
 *      `clientSecret`, `dbPassword`;
 *   4. the operator's rules, from `HUB_REDACTION_RULES_FILE`.
 *
 * A deny-list, and a deliberately weak one: a credential in no known shape, under no telling
 * key, passes. Entropy-based detection is out of scope (superwitness transcripts spec §1). What
 * this does promise is that a value the hub itself holds never leaves in a transcript.
 */
import { existsSync, readFileSync } from "node:fs";

import { config } from "../config";
import { SECRET_QUERY_PARAMS } from "../utils/redact-url-secrets";

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Keep capture group 1 (a label such as `Authorization: `) and replace only what follows. */
  keepPrefix?: boolean;
}

export interface Redacted<T> {
  value: T;
  count: number;
}

export interface Redactor {
  string(s: string): Redacted<string>;
  /** Deep: every string, every key, and the whole value of a credential-named key. */
  value(v: unknown): Redacted<unknown>;
}

/**
 * Every environment variable this hub reads whose value is a credential. Pinned by a test that
 * scans the hub's source: a new `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD` read that is not listed
 * here fails CI until it is.
 */
export const HUB_SECRET_ENV = [
  "API_TOKEN",
  "BETTER_AUTH_SECRET", // signs sessions and encrypts the JWT signing keys at rest
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_WORKER_TOKEN",
  "ENCRYPTION_KEY",
  "FLY_API_TOKEN",
  "FORGE_ADMIN_TOKEN",
  "GITHUB_CLIENT_SECRET", // the hub's one OAuth client secret; HUB_OAUTH_CLIENTS entries are public clients
  "MATRIX_AS_TOKEN",
  "MATRIX_HS_TOKEN",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "RUNTIME_CALLBACK_TOKEN",
  "SPEECH_API_KEY",
  "SUPERPIPELINE_PUSH_SECRET",
  "TRANSCRIBE_API_KEY",
] as const;

/** Shorter values are not used: a 6-character secret would redact ordinary words. */
export const MIN_EXACT_SECRET_LENGTH = 12;

/** The values to redact exactly: the listed variables, plus the password in DATABASE_URL. */
export function hubSecretValues(env: Record<string, string | undefined> = process.env): string[] {
  const values = HUB_SECRET_ENV.map((name) => env[name] ?? "");
  const dbUrl = env.DATABASE_URL;
  if (dbUrl) {
    try {
      values.push(decodeURIComponent(new URL(dbUrl).password));
    } catch {
      // An unparseable DATABASE_URL has no password to find; the hub fails elsewhere.
    }
  }
  return [...new Set(values.filter((v) => v.length >= MIN_EXACT_SECRET_LENGTH))];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rule 2, in the order the spec lists them. Names are what a reader sees in the marker. */
export const PATTERN_RULES: readonly RedactionRule[] = [
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { name: "slack-token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: "authorization", pattern: /(authorization:[ \t]*)[^\r\n"]+/gi, keepPrefix: true },
  { name: "authorization", pattern: /(\b(?:bearer|basic)[ \t]+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi, keepPrefix: true },
  // The user half may be empty: `redis://:password@host`.
  { name: "url-credentials", pattern: /(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]{0,256}:[^\s/@]{1,256}(?=@)/gi, keepPrefix: true },
  { name: "service-credential", pattern: /\bsvc_[0-9a-f]{20}:\S+/g },
  { name: "superpipeline-key", pattern: /\bspa_[A-Za-z0-9_-]{16,}/g },
  {
    name: "query-secret",
    pattern: new RegExp(`([?&](?:${SECRET_QUERY_PARAMS.join("|")})=)[^&\\s"'#]+`, "gi"),
    keepPrefix: true,
  },
  {
    // `export AWS_SECRET_ACCESS_KEY=…`, `DB_PASSWORD='…'`: an UPPER_SNAKE name with a credential
    // word as one whole `_`-separated part (so `MAX_TOKENS=4096` is a count, not a token), then
    // `=`. The name (and an opening quote) is kept. Every part is bounded, and `\b` means a
    // start is tried only where a word begins, so the cost stays linear on megabytes of names.
    // A value another rule already replaced is left alone, so it counts once.
    name: "env-assignment",
    pattern:
      /(\b(?:[A-Z][A-Z0-9]{0,31}_){0,8}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)(?:_[A-Z0-9]{1,32}){0,8}=["']?)(?!\[redacted:)[^\s"']{1,4096}/g,
    keepPrefix: true,
  },
];

/** Rule 3. Case-insensitive, whole key: `db_password`, `X-Api-Key`, `sessionId`, `token`, `aws_secret_access_key`. */
export const SECRET_KEY_NAME =
  /^(.*[_-])?(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie|private[_-]?key|credential|session[_-]?id)$/i;

/**
 * Rule 3, camelCase: `accessToken`, `clientSecret`, `dbPassword`, `secretAccessKey`. Case-
 * sensitive, so the credential word must start a new hump at the end of the key: `tokenizer`,
 * `secretary`, `tokens` and `passwordPolicy` are not credentials.
 */
export const SECRET_KEY_NAME_CAMEL =
  /(?:^|[a-z0-9])(?:Password|Passwd|Secret|Token|ApiKey|AccessKey|PrivateKey|Credential|SessionId)$/;

export const isSecretKeyName = (k: string): boolean => SECRET_KEY_NAME.test(k) || SECRET_KEY_NAME_CAMEL.test(k);

export class RedactionRulesError extends Error {}

/**
 * Rule 4: `HUB_REDACTION_RULES_FILE`, a JSON list of `{"name","pattern"}`.
 *
 * Unset, or set to a path with no file: no extra rules. A file that IS there but cannot be used
 * — not JSON, not a list, an entry without a name or pattern, a pattern that does not compile or
 * that matches the empty string — throws, and `validate-config.ts` turns that into a refused
 * boot: an operator who wrote a rule believes it is applied, and a hub that served content
 * without it would make that belief false.
 */
export function loadOperatorRules(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): RedactionRule[] {
  if (!path || !existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path));
  } catch (e) {
    throw new RedactionRulesError(`${path} is not JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new RedactionRulesError(`${path} must be a JSON list of {"name","pattern"}`);
  return parsed.map((entry, i) => {
    const name = (entry as { name?: unknown })?.name;
    const pattern = (entry as { pattern?: unknown })?.pattern;
    if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw new RedactionRulesError(`${path} entry ${i}: "name" must be 1-64 of A-Z a-z 0-9 _ . -`);
    }
    if (typeof pattern !== "string" || pattern === "") {
      throw new RedactionRulesError(`${path} entry ${i} (${name}): "pattern" must be a non-empty string`);
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, "g");
    } catch (e) {
      throw new RedactionRulesError(`${path} entry ${i} (${name}): invalid regex: ${(e as Error).message}`);
    }
    if (new RegExp(pattern).test("")) {
      throw new RedactionRulesError(`${path} entry ${i} (${name}): pattern matches the empty string`);
    }
    return { name, pattern: re };
  });
}

export function createRedactor(opts: { secrets: string[]; operatorRules: RedactionRule[] }): Redactor {
  const secrets = [...opts.secrets].sort((a, b) => b.length - a.length);
  const exact: RedactionRule[] =
    secrets.length === 0 ? [] : [{ name: "hub-secret", pattern: new RegExp(secrets.map(escape).join("|"), "g") }];
  const rules = [...exact, ...PATTERN_RULES, ...opts.operatorRules];

  function string(s: string): Redacted<string> {
    let count = 0;
    let out = s;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, (...m: unknown[]) => {
        count += 1;
        const marker = `[redacted:${rule.name}]`;
        return rule.keepPrefix ? `${m[1] as string}${marker}` : marker;
      });
    }
    return { value: out, count };
  }

  function value(v: unknown): Redacted<unknown> {
    if (typeof v === "string") return string(v);
    if (Array.isArray(v)) {
      let count = 0;
      const out = v.map((x) => {
        const r = value(x);
        count += r.count;
        return r.value;
      });
      return { value: out, count };
    }
    if (v !== null && typeof v === "object") {
      let count = 0;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const key = string(k);
        count += key.count;
        if (isSecretKeyName(k) && x !== null && x !== undefined && x !== "") {
          out[key.value] = "[redacted:key-name]";
          count += 1;
          continue;
        }
        const r = value(x);
        count += r.count;
        out[key.value] = r.value;
      }
      return { value: out, count };
    }
    return { value: v, count: 0 };
  }

  return { string, value };
}

let live: Redactor | null = null;

/**
 * The hub's redactor: its own secrets and the operator's rules, read once. Boot has already
 * refused a bad rules file (`validate-config.ts`), so this cannot throw in a running hub.
 */
export function contentRedactor(): Redactor {
  live ??= createRedactor({
    secrets: hubSecretValues(),
    operatorRules: loadOperatorRules(config.redaction.rulesFile),
  });
  return live;
}
