import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The session open asks the remote bench stage's hold only once the composition root installs it
// (`services/acp` sits below the bridge, so the check is injected). Without this line every Console,
// Matrix and editor open would go ahead on a station whose terminal points at a card's bench.
test("the composition root installs the remote bench stage's hold on every session open", () => {
  const index = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  expect(index).toMatch(/^setStationHold\(stationBenchBusy\);$/m);
});
