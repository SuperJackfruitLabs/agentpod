import { expect, test } from "bun:test";
import { recordSalaamUsage } from "./salaam-usage";

const usage = (status: string, subtotal: Record<string, number> | null) => ({
  version: 1,
  recorded_by: "salaam-usage-ledger",
  session_id: "00000000-0000-4000-8000-000000000000",
  includes_children: true,
  status,
  coverage: { observations: 1, recorded: 1, unknown: 0, estimated: 0 },
  recorded_subtotal: subtotal,
  cost_provenance: "ledger-recorded-not-provider-bill",
  truncated: false,
  observations: [],
});
function fake() {
  const adds: [string, number, Record<string, unknown>][] = [];
  const counter = (name: string) => ({ add: (n: number, a: Record<string, unknown> = {}) => adds.push([name, n, a]) });
  return { adds, meter: { createCounter: (name: string) => counter(name) } };
}
const attrs = { "harness.name": "salaam", "run.id": "run_abcdef1", "attempt.id": "w-1" };

test("recorded usage becomes the token and cost metrics other harnesses export", () => {
  const f = fake();
  recordSalaamUsage(f.meter as never, usage("known", {
    input_tokens: 1200, output_tokens: 300, cache_read_tokens: 50, cache_write_tokens: 0, cost_usd: 0.012,
  }), attrs);
  expect(f.adds).toEqual([
    ["salaam.token.usage", 1200, { ...attrs, type: "input", "usage.status": "known" }],
    ["salaam.token.usage", 300, { ...attrs, type: "output", "usage.status": "known" }],
    ["salaam.token.usage", 50, { ...attrs, type: "cacheRead", "usage.status": "known" }],
    ["salaam.cost.usage", 0.012, { ...attrs, "usage.status": "known", "cost.provenance": "ledger-recorded-not-provider-bill" }],
  ]);
});

test("unknown usage is counted as unknown, never as zero tokens", () => {
  const f = fake();
  recordSalaamUsage(f.meter as never, usage("unknown", null), attrs);
  expect(f.adds).toEqual([["salaam.usage.unknown", 1, { ...attrs, "usage.status": "unknown" }]]);
  const g = fake();
  recordSalaamUsage(g.meter as never, { not: "usage" }, attrs);
  expect(g.adds).toEqual([]);
});
