import { test, expect, vi, beforeEach } from "vitest";

vi.mock("./client", () => ({ http: vi.fn() }));

import { http } from "./client";
import { applyStationTranscription } from "./transcription";

/**
 * Pushing a station's voice-note setting into its harness: one POST with no
 * body — the node fetches the setting itself, so the console never sends a
 * key or url here.
 */

beforeEach(() => vi.clearAllMocks());

test("applyStationTranscription POSTs to the station's apply route with no body", async () => {
  vi.mocked(http).mockResolvedValue({ applied: true, mode: "on", model: "large-v3-turbo", restarted: true });
  const result = await applyStationTranscription("st/1");
  expect(http).toHaveBeenCalledWith("/api/stations/st%2F1/transcription/apply", { method: "POST" });
  expect(result).toEqual({ applied: true, mode: "on", model: "large-v3-turbo", restarted: true });
});

test("a hub refusal surfaces as the thrown error", async () => {
  vi.mocked(http).mockRejectedValue(new Error("the harness could not be restarted"));
  await expect(applyStationTranscription("st_1")).rejects.toThrow("could not be restarted");
});
