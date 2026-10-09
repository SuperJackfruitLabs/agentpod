import { expect, test } from "bun:test";

import { createSuperlibraryClient } from "./client";
import { RELATED_TIMEOUT_MS, createFetchRelatedWork, createPrefetchRelatedWork } from "./related";

const ok = {
  items: [
    {
      itemId: "itm_0000000000000001",
      kind: "work-record",
      title: "Pricing v1",
      outcome: "rejected",
      scope: "board:brd_00000000000000b1",
      provenance: { board: "brd_00000000000000b1", card: "card_0000000000000001", sourceKind: "superpipeline" },
      snippet: "s",
      url: "https://app.superlibrary.dev/a/itm_0000000000000001",
      score: 1,
      supersededBy: null,
      wrapped: "<library-item …>",
      tokens: 10,
    },
  ],
};
const lib = (respond: (...a: never[]) => Promise<Response>) =>
  ({ asAgent: () => ({ request: respond }), asService: () => { throw new Error(); }, invalidateRoster: async () => {} }) as never;
const quiet = { info: () => {}, warn: () => {} };
const input = { tenantId: "t", boardId: "brd_00000000000000b1", cardId: "card_00000000000000c1", principal: "prn_000000000000000000a2" };

test("maps Superlibrary's related items into the prompt's shape, with the text the server capped", async () => {
  const f = createFetchRelatedWork({ client: () => lib(async () => Response.json(ok)), enabled: async () => true, log: quiet });
  const r = await f(input);
  expect(r).toEqual([
    {
      itemId: "itm_0000000000000001",
      kind: "work-record",
      title: "Pricing v1",
      outcome: "rejected",
      url: "https://app.superlibrary.dev/a/itm_0000000000000001",
      board: "brd_00000000000000b1",
      card: "card_0000000000000001",
      source: "superpipeline",
      text: "s",
    },
  ]);
});

test("the body inside Superlibrary's wrapped block is the text, not the shorter snippet", async () => {
  const wrapped =
    '<library-item id="itm_0000000000000001" kind="work-record" outcome="rejected" url="https://app.superlibrary.dev/a/itm_0000000000000001">\ntitle: Pricing v1\nThe whole capped body.\nSecond line.\n</library-item>';
  const f = createFetchRelatedWork({
    client: () => lib(async () => Response.json({ items: [{ ...ok.items[0], wrapped }] })),
    enabled: async () => true,
    log: quiet,
  });
  expect((await f(input))?.[0]?.text).toBe("The whole capped body.\nSecond line.");
});

test("the call is the agent's own: its principal, the related path, the card id", async () => {
  const seen: unknown[] = [];
  const client = {
    asAgent: (prn: string) => ({
      request: async (method: string, path: string, init: unknown) => {
        seen.push({ prn, method, path, init });
        return Response.json({ items: [] });
      },
    }),
    asService: () => { throw new Error("never the service token"); },
    invalidateRoster: async () => {},
  } as never;
  expect(await createFetchRelatedWork({ client: () => client, enabled: async () => true, log: quiet })(input)).toEqual([]);
  expect(seen).toEqual([
    { prn: "prn_000000000000000000a2", method: "POST", path: "/api/v1/related", init: { json: { cardId: "card_00000000000000c1" }, timeoutMs: 2500 } },
  ]);
});

test("a library failure leaves the prompt without the section", async () => {
  for (const respond of [
    async () => new Response(null, { status: 503 }),
    async () => { throw new Error("down"); },
    async () => new Response("not json"),
    async () => Response.json({ nope: true }),
  ]) {
    const f = createFetchRelatedWork({ client: () => lib(respond), enabled: async () => true, log: quiet });
    expect(await f({ tenantId: "t", boardId: "b", cardId: "c", principal: "prn_000000000000000000a2" })).toBeUndefined();
  }
});

test("a board setting that cannot be read leaves the section out too", async () => {
  const f = createFetchRelatedWork({
    client: () => lib(async () => Response.json(ok)),
    enabled: async () => { throw new Error("db down"); },
    log: quiet,
  });
  expect(await f(input)).toBeUndefined();
});

test("one malformed item is dropped, the rest still reach the prompt", async () => {
  const bad = { ...ok.items[0], itemId: "not-an-item-id" };
  const noUrl = { ...ok.items[0], itemId: "itm_0000000000000002", url: "nope" };
  const f = createFetchRelatedWork({
    client: () => lib(async () => Response.json({ items: [bad, ok.items[0], noUrl, null] })),
    enabled: async () => true,
    log: quiet,
  });
  expect((await f(input))?.map((r) => r.itemId)).toEqual(["itm_0000000000000001"]);
});

// This one proves the request is given timeoutMs 2500; the cut itself, for a call that ignores its
// timeout, is carried by the two deadline tests below ("never settles", "token mint never answers").
test("a hanging library call is cut at 2.5 s and the prompt has no section", async () => {
  let timeout = 0;
  const f = createFetchRelatedWork({
    client: () =>
      ({
        asAgent: () => ({
          request: (_m: string, _p: string, init: { timeoutMs: number }) => {
            timeout = init.timeoutMs;
            return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20));
          },
        }),
        asService: () => { throw new Error(); },
        invalidateRoster: async () => {},
      }) as never,
    enabled: async () => true,
    log: quiet,
  });
  expect(await f(input)).toBeUndefined();
  expect(timeout).toBe(2500);
  expect(RELATED_TIMEOUT_MS).toBe(2500);
});

test("a request that ignores its timeout and never settles is still cut by the deadline", async () => {
  const warned: unknown[] = [];
  const f = createFetchRelatedWork({
    client: () => lib(() => new Promise<Response>(() => {})),
    enabled: async () => true,
    log: { info: () => {}, warn: (_m, meta) => warned.push(meta) },
    deadlineMs: 50,
  });
  const t0 = Date.now();
  expect(await f(input)).toBeUndefined();
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(warned).toHaveLength(1);
});

test("a token mint that never answers counts against the same deadline", async () => {
  // The real client: its own timeoutMs starts only after the token is minted, so the mint must be inside the deadline.
  const client = createSuperlibraryClient({
    url: "https://library.test",
    audience: "https://library.test",
    plane: { serviceToken: () => new Promise(() => {}), agentToken: () => new Promise(() => {}) } as never,
    fetch: async () => Response.json(ok),
  });
  const f = createFetchRelatedWork({ client: () => client, enabled: async () => true, log: quiet, deadlineMs: 50 });
  const t0 = Date.now();
  expect(await f(input)).toBeUndefined();
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("a principal lookup is awaited only once the library is configured and the board is on", async () => {
  let looked = 0;
  const principal = async () => { looked++; return "prn_000000000000000000a2"; };
  const client = () => lib(async () => Response.json({ items: [] }));
  await createFetchRelatedWork({ client: () => null, enabled: async () => true, log: quiet })({ ...input, principal });
  await createFetchRelatedWork({ client, enabled: async () => false, log: quiet })({ ...input, principal });
  expect(looked).toBe(0);
  expect(await createFetchRelatedWork({ client, enabled: async () => true, log: quiet })({ ...input, principal })).toEqual([]);
  expect(looked).toBe(1);
});

test("a principal lookup that never answers is cut by the same deadline", async () => {
  const f = createFetchRelatedWork({ client: () => lib(async () => Response.json(ok)), enabled: async () => true, log: quiet, deadlineMs: 50 });
  const t0 = Date.now();
  expect(await f({ ...input, principal: () => new Promise(() => {}) })).toBeUndefined();
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("a lookup that finds no principal makes no call", async () => {
  let calls = 0;
  const f = createFetchRelatedWork({ client: () => lib(async () => { calls++; return Response.json(ok); }), enabled: async () => true, log: quiet });
  expect(await f({ ...input, principal: async () => null })).toBeUndefined();
  expect(calls).toBe(0);
});

test("off for the board, unconfigured, or no principal: no call at all", async () => {
  let calls = 0;
  const client = () => lib(async () => { calls++; return Response.json(ok); });
  const i = { tenantId: "t", boardId: "b", cardId: "c", principal: "prn_000000000000000000a2" };
  expect(await createFetchRelatedWork({ client, enabled: async () => false, log: quiet })(i)).toBeUndefined();
  expect(await createFetchRelatedWork({ client: () => null, enabled: async () => true, log: quiet })(i)).toBeUndefined();
  expect(await createFetchRelatedWork({ client, enabled: async () => true, log: quiet })({ ...i, principal: null })).toBeUndefined();
  expect(calls).toBe(0);
});

test("one info line when the section is attached: ids, boards and outcomes, never titles or text", async () => {
  const infos: Array<[string, unknown]> = [];
  const warns: unknown[] = [];
  const f = createFetchRelatedWork({
    client: () => lib(async () => Response.json(ok)),
    enabled: async () => true,
    log: { info: (m, meta) => infos.push([m, meta]), warn: (m) => warns.push(m) },
  });
  await f(input);
  expect(infos).toEqual([
    [
      "related prior work attached",
      {
        cardId: "card_00000000000000c1",
        boardId: "brd_00000000000000b1",
        count: 1,
        elapsedMs: expect.any(Number),
        serverTiming: "",
        items: [{ itemId: "itm_0000000000000001", board: "brd_00000000000000b1", outcome: "rejected" }],
      },
    ],
  ]);
  expect(JSON.stringify(infos)).not.toContain("Pricing v1");
  expect(warns).toHaveLength(0);
});

test("one warning per failure, naming no body and no token", async () => {
  const warns: Array<[string, unknown]> = [];
  const f = createFetchRelatedWork({
    client: () => lib(async () => new Response("SECRET-BODY {", { status: 200 })),
    enabled: async () => true,
    log: { info: () => {}, warn: (m, meta) => warns.push([m, meta]) },
  });
  await f(input);
  expect(warns).toHaveLength(1);
  expect(warns[0]![0]).toBe("related prior work skipped");
  expect(JSON.stringify(warns)).not.toContain("SECRET");
});

test("the attached line carries the elapsed time and Superlibrary's stage timings", async () => {
  const infos: Array<[string, Record<string, unknown>]> = [];
  const f = createFetchRelatedWork({
    client: () =>
      lib(async () =>
        Response.json(ok, {
          headers: { "server-timing": 'auth;dur=5, embed;dur=200, app;dur=310, x;desc="itm_0000000000000001"' },
        }),
      ),
    enabled: async () => true,
    log: { info: (m, meta) => infos.push([m, meta as Record<string, unknown>]), warn: () => {} },
  });
  await f(input);
  const meta = infos[0]![1];
  expect(meta.serverTiming).toBe("auth;dur=5, embed;dur=200, app;dur=310");
  expect(typeof meta.elapsedMs).toBe("number");
});

test("the skipped line carries the elapsed time", async () => {
  const warns: Array<[string, Record<string, unknown>]> = [];
  const f = createFetchRelatedWork({
    client: () => lib(async () => new Response(null, { status: 503 })),
    enabled: async () => true,
    log: { info: () => {}, warn: (m, meta) => warns.push([m, meta as Record<string, unknown>]) },
  });
  await f(input);
  expect(typeof warns[0]![1].elapsedMs).toBe("number");
});

test("no prefetch when Superlibrary is unconfigured or the board is off", async () => {
  let enabledCalls = 0;
  let principalCalls = 0;
  let warmed = 0;
  const principal = async () => { principalCalls++; return "prn_000000000000000000a2"; };
  const client = { warmAgent: async () => { warmed++; } } as never;
  createPrefetchRelatedWork({ client: () => null, enabled: async () => { enabledCalls++; return true; } })({ ...input, principal });
  createPrefetchRelatedWork({ client: () => client, enabled: async () => false })({ ...input, principal });
  await new Promise((r) => setTimeout(r, 20));
  expect(enabledCalls).toBe(0);
  expect(principalCalls).toBe(0);
  expect(warmed).toBe(0);
});

test("the prefetch warms the agent's token when enabled, and swallows a failing warm-up", async () => {
  const warmed: string[] = [];
  const ok1 = { warmAgent: async (p: string) => { warmed.push(p); } } as never;
  createPrefetchRelatedWork({ client: () => ok1, enabled: async () => true })({ ...input, principal: async () => "prn_000000000000000000a2" });
  await new Promise((r) => setTimeout(r, 20));
  expect(warmed).toEqual(["prn_000000000000000000a2"]);
  const bad = { warmAgent: async () => { throw new Error("boom"); } } as never;
  const unhandled: unknown[] = [];
  const h = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", h);
  createPrefetchRelatedWork({ client: () => bad, enabled: async () => true })(input);
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", h);
  expect(unhandled).toEqual([]);
});

test("stage timings are cut at whole entries, never mid-entry", async () => {
  const { stageTimings } = await import("./related");
  const entry = "stage0;dur=1234567";
  const h = Array.from({ length: 40 }, () => entry).join(", ");
  const out = stageTimings(h);
  expect(out.length).toBeLessThanOrEqual(400);
  expect(out.split(", ").every((e) => e === entry)).toBe(true);
});

test("the prefetch uses the claim's shared switch read when given one", async () => {
  let own = 0;
  let shared = 0;
  const warmed: string[] = [];
  const client = { warmAgent: async (p: string) => { warmed.push(p); } } as never;
  createPrefetchRelatedWork({ client: () => client, enabled: async () => { own++; return true; } })({
    ...input,
    enabled: async () => { shared++; return true; },
  });
  await new Promise((r) => setTimeout(r, 20));
  expect([own, shared, warmed.length]).toEqual([0, 1, 1]);
});
