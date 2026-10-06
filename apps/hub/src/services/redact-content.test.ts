import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../config";
import { collectConfigErrors } from "../utils/validate-config";
import {
  HUB_SECRET_ENV,
  RedactionRulesError,
  createRedactor,
  hubSecretValues,
  loadOperatorRules,
} from "./redact-content";

/** Credential-shaped strings are assembled at runtime, so this file holds none literally. */
const j = (...parts: string[]) => parts.join("");
const a = (n: number) => "a".repeat(n);
const r = createRedactor({ secrets: [], operatorRules: [] });

/** [rule, a value it must redact, a near-miss it must leave alone] — one row per spec rule. */
const RULES: Array<[string, string, string]> = [
  ["anthropic-key", j("sk-", "ant-api03-", a(20)), j("sk-", "ant-api03-", a(5))],
  ["openai-key", j("sk-", "proj-", a(20)), j("ta", "sk-", a(30))],
  ["aws-access-key", j("AK", "IA", "ABCDEFGHIJKLMNOP"), j("AK", "IA", "ABCDEFGHIJKLMNO")],
  ["github-token", j("gh", "p_", a(36)), j("gh", "p_", a(35))],
  ["github-token", j("github", "_pat_", a(40)), j("github", "_pat_", a(39))],
  ["slack-token", j("xo", "xb-", "1234567890"), j("xo", "xb-", "12345678")],
  ["stripe-key", j("sk", "_live_", a(16)), j("sk", "_live_", a(15))],
  ["google-api-key", j("AI", "za", a(35)), j("AI", "za", a(34))],
  ["jwt", j("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxIn0.sig"), j("ey", "JhbGciOiJIUzI1NiJ9.notajwt.sig")],
  ["private-key", j("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIabc\n-----END RSA ", "PRIVATE KEY-----"), "-----BEGIN PUBLIC KEY-----\nMIIabc\n-----END PUBLIC KEY-----"],
  ["authorization", j("Authorization: ", "Bearer abc.def"), "the authorization header is required"],
  ["authorization", j("Bearer ", "abc123def456"), "Basic understanding, from the bearer of bad news"],
  ["url-credentials", j("postgres://", "user:pw", "@db:5432/x"), "https://example.com:8080/a@b"],
  ["service-credential", j("svc_", "0123456789abcdef0123", ":rest"), j("svc_", "0123456789abcdef012", ":rest")],
  ["superpipeline-key", j("spa_", a(16)), j("spa_", a(15))],
  ["query-secret", j("GET /x?access", "_token=abc123&ok=1"), "GET /x?tokens=abc"],
];

describe("pattern rules: one hit and one near-miss each", () => {
  for (const [name, hit, miss] of RULES) {
    test(`${name}: redacts ${JSON.stringify(hit.slice(0, 24))}…, leaves ${JSON.stringify(miss.slice(0, 24))}…`, () => {
      const got = r.string(`before ${hit} after`);
      expect(got.value).toContain(`[redacted:${name}]`);
      expect(got.count).toBe(1);
      expect(r.string(miss)).toEqual({ value: miss, count: 0 });
    });
  }

  test("a labelled credential keeps its label", () => {
    expect(r.string(j("Authorization: ", "Bearer x1y2z3w4v5")).value).toBe("Authorization: [redacted:authorization]");
    expect(r.string(j("https://", "me:pw", "@host/p")).value).toBe("https://[redacted:url-credentials]@host/p");
  });
});

describe("exact values of the hub's own secrets", () => {
  test("a configured secret of 12+ characters is redacted wherever it appears", () => {
    const secret = j("hub-api-", "token-0123456789");
    const rr = createRedactor({ secrets: hubSecretValues({ API_TOKEN: secret }), operatorRules: [] });
    expect(rr.string(`use ${secret} now`)).toEqual({ value: "use [redacted:hub-secret] now", count: 1 });
  });

  test("a value under 12 characters is never used", () => {
    expect(hubSecretValues({ API_TOKEN: "short-value" })).toEqual([]);
  });

  test("the database password is one of them", () => {
    const pw = j("db-pass", "word-0123456789");
    expect(hubSecretValues({ DATABASE_URL: `postgres://agentpod:${encodeURIComponent(pw)}@db:5432/x` })).toEqual([pw]);
  });

  test("every credential the hub reads from its environment is listed", () => {
    // Scan the hub's source for env reads of *_TOKEN / *_SECRET / *_KEY / *_PASSWORD. A new one
    // that is not in HUB_SECRET_ENV is a secret that could leave in a transcript.
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          const src = readFileSync(p, "utf8");
          for (const m of src.matchAll(/(?:process\.env|\benv)(?:\.|\[['"])([A-Z][A-Z0-9_]+)|getEnv(?:Int|Bool)?\(['"]([A-Z][A-Z0-9_]+)/g)) {
            const name = m[1] ?? m[2]!;
            if (/(TOKEN|SECRET|_KEY|PASSWORD)(_ID)?$/.test(name)) names.add(name);
          }
        }
      }
    };
    walk(join(import.meta.dir, ".."));
    expect(names.size).toBeGreaterThan(5);
    expect([...names].sort()).toEqual([...HUB_SECRET_ENV].sort());
  });
});

describe("key names", () => {
  test("the whole value of a credential-named key, three levels deep", () => {
    const got = r.value({ a: { b: { c: { db_password: "hunter2", "X-Api-Key": { nested: 1 }, sessionId: "s", note: "ok" } } } });
    expect(got).toEqual({
      value: { a: { b: { c: { db_password: "[redacted:key-name]", "X-Api-Key": "[redacted:key-name]", sessionId: "[redacted:key-name]", note: "ok" } } } },
      count: 3,
    });
  });

  test("a key that merely contains a word is not one: tokenizer, secretary", () => {
    expect(r.value({ tokenizer: "bpe", secretary: "x" })).toEqual({ value: { tokenizer: "bpe", secretary: "x" }, count: 0 });
  });
});

describe("cost: no rule is quadratic", () => {
  // A tool output can be megabytes. The first draft of the URL rule took minutes on 2 MiB of
  // one letter; bun's default 5s test timeout is the guard.
  for (const [label, s] of [
    ["one letter", "y".repeat(2 * 1024 * 1024)],
    ["a JWT prefix", "eyJ" + "a".repeat(1024 * 1024)],
    ["a scheme prefix", "https://" + "u".repeat(1024 * 1024) + ":p@x"],
    ["a label", "Bearer " + "a".repeat(1024 * 1024)],
    ["repeated JWT prefixes", "eyJ-".repeat(512 * 1024)],
    ["repeated key headers with no end", j("-----BEGIN ", "PRIVATE KEY-----").repeat(Math.ceil((2 * 1024 * 1024) / 27))],
  ] as const) {
    test(`2 MiB of ${label} redacts in well under a second`, () => {
      const t = performance.now();
      r.string(s);
      expect(performance.now() - t).toBeLessThan(1000);
    });
  }
});

describe("operator rules (HUB_REDACTION_RULES_FILE)", () => {
  const dir = mkdtempSync(join(tmpdir(), "redaction-"));
  const file = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  test("unset, or a path with no file, is no extra rules", () => {
    expect(loadOperatorRules("")).toEqual([]);
    expect(loadOperatorRules(join(dir, "absent.json"))).toEqual([]);
  });

  test("a rule applies after the built-ins, under its own name", () => {
    const rules = loadOperatorRules(file("ok.json", JSON.stringify([{ name: "ticket", pattern: "TKT-[0-9]{6}" }])));
    const rr = createRedactor({ secrets: [], operatorRules: rules });
    expect(rr.string("see TKT-123456").value).toBe("see [redacted:ticket]");
  });

  for (const [why, body] of [
    ["an invalid regex", JSON.stringify([{ name: "bad", pattern: "([" }])],
    ["a pattern that matches the empty string", JSON.stringify([{ name: "all", pattern: "x*" }])],
    ["not JSON", "{nope"],
    ["not a list", JSON.stringify({ name: "x", pattern: "y" })],
    ["an entry without a name", JSON.stringify([{ pattern: "y" }])],
  ] as const) {
    test(`${why} throws`, () => {
      expect(() => loadOperatorRules(file(`${why.replaceAll(" ", "-")}.json`, body))).toThrow(RedactionRulesError);
    });
  }
});

describe("boot", () => {
  test("a bad rules file stops the start: boot validation names the variable", () => {
    const bad = join(mkdtempSync(join(tmpdir(), "redaction-boot-")), "rules.json");
    writeFileSync(bad, JSON.stringify([{ name: "bad", pattern: "([" }]));
    const errors = collectConfigErrors({ ...config, redaction: { rulesFile: bad } } as typeof config, () => {});
    expect(errors.map((e) => e.field)).toContain("HUB_REDACTION_RULES_FILE");
    expect(collectConfigErrors({ ...config, redaction: { rulesFile: "" } } as typeof config, () => {}).map((e) => e.field))
      .not.toContain("HUB_REDACTION_RULES_FILE");
  });
});
