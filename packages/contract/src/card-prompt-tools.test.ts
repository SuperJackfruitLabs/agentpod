/**
 * The card prompt names SuperPipeline's tools in prose, and a harness calls exactly what it reads.
 * Treaty 0.0.19 publishes those tools as a catalog (`schemas/mcp/superpipeline.v1.json`, the
 * `superpipeline.mcp` crossing; phase 3, ruling 3), so every `superpipeline_*` name the prompt can
 * render, in every variant, and every one this package's sources name, must be a tool in it
 * (review focus 2): a prompt naming a removed or misspelt tool fails here, not on a station.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpCatalog, unknownTools } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";

import { CARD_PROMPT_VERSION, CardPrompt, renderCardPrompt } from "./card-prompt";

const catalog = mcpCatalog(loadInstalledBundle(), "superpipeline.v1");

/** Every `superpipeline_<verb>` in a text. */
const toolNamesIn = (text: string): string[] => [...new Set(text.match(/\bsuperpipeline_[a-z_]+\b/g) ?? [])];

const base = {
  version: CARD_PROMPT_VERSION,
  source: "superpipeline",
  boardId: "brd_00000000000000b1",
  externalRunId: "run_00000000000000d1",
  card: { id: "card_00000000000000c1", title: "Ship the pricing page" },
  attempt: { number: 1 },
};

/** Every combination of the fields that decide which tools the prompt names. */
const variants = [null, { id: "run_00000000000000d1" }].flatMap((run) =>
  [undefined, []].flatMap((comments) =>
    [undefined, true].map((libraryTools) => ({ run, comments, libraryTools })),
  ),
);

describe("the card prompt names only tools in SuperPipeline's catalog", () => {
  test("the catalog is the `superpipeline` server the bridge hands the harness", () =>
    expect(catalog.server.name).toBe("superpipeline"));

  const named = new Set<string>();
  for (const v of variants) {
    test(`run ${v.run ? "set" : "null"}, comments ${v.comments ? "present" : "absent"}, library tools ${v.libraryTools ? "on" : "off"}`, () => {
      const text = renderCardPrompt(
        CardPrompt.parse({
          ...base,
          ...(v.run ? { run: v.run } : {}),
          ...(v.comments ? { comments: v.comments } : {}),
          ...(v.libraryTools ? { libraryTools: v.libraryTools } : {}),
        }),
      );
      const names = toolNamesIn(text);
      for (const n of names) named.add(n);
      expect(unknownTools(catalog, names)).toEqual([]);
    });
  }

  test("the variants above render the board verbs the prompt teaches", () => {
    for (const verb of [
      "superpipeline_complete",
      "superpipeline_block",
      "superpipeline_get_run",
      "superpipeline_add_reference",
      "superpipeline_list_comments",
      "superpipeline_post_comment",
    ])
      expect(named.has(verb)).toBe(true);
  });

  test("the sources that name tools in prose name only catalogued ones", () => {
    for (const file of ["card-prompt.ts", "acp-session.ts"]) {
      const names = toolNamesIn(readFileSync(join(import.meta.dir, file), "utf8"));
      expect({ file, unknown: unknownTools(catalog, names) }).toEqual({ file, unknown: [] });
    }
  });

  test("a prompt naming a tool the catalog does not hold is caught", () =>
    expect(unknownTools(catalog, toolNamesIn("call `superpipeline_finish` when done"))).toEqual([
      "superpipeline_finish",
    ]));
});
