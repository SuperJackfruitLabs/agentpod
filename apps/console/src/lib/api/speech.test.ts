import { test, expect, vi, beforeEach } from "vitest";

vi.mock("./client", () => ({ http: vi.fn(), hubUrl: () => "http://hub.test" }));

import { http } from "./client";
import { applyStationSpeech } from "./speech";

/**
 * Pushing a station's voice into its harness: one POST with no body — the
 * node fetches the setting itself, so the console never sends a key or url.
 */

beforeEach(() => vi.clearAllMocks());

test("applyStationSpeech POSTs to the station's apply route with no body", async () => {
  const answer = { applied: true, mode: "on", voice: "af_heart", speakMode: "always", autoSpeak: true, restarted: true };
  vi.mocked(http).mockResolvedValue(answer);
  const result = await applyStationSpeech("st/1");
  expect(http).toHaveBeenCalledWith("/api/stations/st%2F1/speech/apply", { method: "POST" });
  expect(result).toEqual(answer);
});

test("a hub refusal surfaces as the thrown error", async () => {
  vi.mocked(http).mockRejectedValue(new Error("its node-agent predates voice replies"));
  await expect(applyStationSpeech("st_1")).rejects.toThrow("predates");
});
