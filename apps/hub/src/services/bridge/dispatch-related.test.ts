/**
 * The card prompt's "Related prior work" section, as `assemblePrompt` builds it.
 *
 * Unit-level: the board's context read and both seams are stated, so nothing here touches the
 * database. The whole claim, and the production defaults with no seam injected, are in
 * `tests/integration/bridge-dispatch-related.test.ts`.
 */
import { afterEach, expect, test } from "bun:test";
import { renderCardPrompt, type CardPromptRelated } from "@agentpod/contract";

import { setSuperlibraryClientForTests } from "../superlibrary/client";
import { assemblePrompt, type DispatchDeps } from "./dispatch";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** The principal a seam was given, a lookup resolved. */
const principalOf = async (p: string | null | (() => Promise<string | null>)) => (typeof p === "function" ? await p() : p);

const TENANT = "tnt_00000000000000a1";
const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";
const RUN = "run_00000000000000d1";
const PRINCIPAL = "prn_000000000000000000a2";

const work = {
  runId: RUN,
  leaseEpoch: 1,
  card: { id: CARD, title: "Ship the pricing page", attemptCount: 1 },
  stage: { key: "work", name: "Work" },
  handoff: null,
} as never;

const related: CardPromptRelated = {
  itemId: "itm_0000000000000001",
  kind: "work-record",
  title: "Pricing v1",
  outcome: "rejected",
  url: "https://app.superlibrary.dev/a/itm_0000000000000001",
  text: "Tried a toggle; rejected.",
};

function deps(over: Partial<DispatchDeps>): DispatchDeps {
  return {
    client: {
      context: async () => ({ card: { id: CARD, title: "Ship the pricing page", spec: "Build it." }, references: [] }),
    } as never,
    acp: {} as never,
    agent: { key: "a", boardId: BOARD, token: "spa_x", stationId: "station_x", hubUserId: "usr_x", mode: "full-auto" },
    tenantId: TENANT,
    source: "superpipeline",
    ...over,
  };
}

const prn = async () => PRINCIPAL;

test("the prompt section is the agent's related call", async () => {
  const seen: unknown[] = [];
  const prompt = renderCardPrompt(
    await assemblePrompt(
      deps({ relatedWork: async (input) => { seen.push({ ...input, principal: await principalOf(input.principal) }); return [related]; } }),
      work,
      prn,
    ),
  );
  expect(seen).toEqual([{ tenantId: TENANT, boardId: BOARD, cardId: CARD, principal: PRINCIPAL }]);
  expect(prompt).toContain("## Related prior work");
  expect(prompt).toContain("Tried a toggle; rejected.");
});

test("the claim goes ahead without the section when related work is unavailable", async () => {
  const p = await assemblePrompt(deps({ relatedWork: async () => undefined }), work, prn);
  expect(p.relatedWork).toBeUndefined();
  const prompt = renderCardPrompt(p);
  expect(prompt).not.toContain("## Related prior work");
  expect(prompt).toContain("## Completing this card");
});

test("an empty answer is still passed: Superlibrary answered and found nothing", async () => {
  const p = await assemblePrompt(deps({ relatedWork: async () => [] }), work, prn);
  expect(p.relatedWork).toEqual([]);
  expect(renderCardPrompt(p)).not.toContain("## Related prior work");
});

test("a seam that throws anyway leaves the section out, and the prompt is still built", async () => {
  const p = await assemblePrompt(deps({ relatedWork: async () => { throw new Error("boom"); } }), work, prn);
  expect(p.relatedWork).toBeUndefined();
});

test("no principal reaches the fetcher as null, for it to decline", async () => {
  const seen: unknown[] = [];
  await assemblePrompt(deps({ relatedWork: async (i) => { seen.push(await principalOf(i.principal)); return undefined; } }), work, async () => null);
  expect(seen).toEqual([null]);
});

test("Superlibrary unconfigured: the occupant is never looked up while the prompt is built", async () => {
  // The claim path holds the session open for whatever the prompt awaits. With no library to ask,
  // that must be nothing: the attempt looks the occupant up later, at its first ACP event.
  restore = setSuperlibraryClientForTests(null);
  let looked = 0;
  const p = await assemblePrompt(deps({}), work, async () => { looked++; return PRINCIPAL; });
  expect(looked).toBe(0);
  expect(p.relatedWork).toBeUndefined();
});

test("the agent token is warmed while the run context is read", async () => {
  const events: string[] = [];
  let lookups = 0;
  const lookup = async () => { lookups++; return PRINCIPAL; };
  await assemblePrompt(
    deps({
      client: {
        context: async () => {
          await new Promise((r) => setTimeout(r, 100));
          events.push("context:end");
          return { card: { id: CARD, title: "Ship the pricing page", spec: "Build it." }, references: [] };
        },
      } as never,
      prefetchRelated: () => { events.push("prefetch"); },
      relatedWork: async (i) => { await principalOf(i.principal); return undefined; },
    }),
    work,
    lookup,
  );
  expect(events).toEqual(["prefetch", "context:end"]);
  expect(lookups).toBe(1);
});
