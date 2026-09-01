import { describe, it, expect } from "bun:test";
import { VERB_PARAMS, VERB_RESULTS, InputMsg, ResizeMsg, StreamMsg } from "./protocol";
import { Capability } from "./station";

it("capability enum includes write capabilities", () => {
  expect(Capability.parse("fs.write")).toBe("fs.write");
  expect(Capability.parse("terminal")).toBe("terminal");
  expect(() => Capability.parse("bogus")).toThrow();
});
it("fs.write params + results round-trip", () => {
  expect(VERB_PARAMS["fs.write"].parse({ key:"k", path:"a.txt", content:"x", encoding:"utf8", backup:true })).toBeTruthy();
  expect(VERB_RESULTS["fs.write"].parse({ bytesWritten: 1, backupPath: "a.txt.bak" })).toBeTruthy();
});
it("term.open returns sessionId; input/resize frames parse", () => {
  expect(VERB_RESULTS["term.open"].parse({ sessionId: "s1" })).toBeTruthy();
  expect(InputMsg.parse({ type:"input", id:"r1", data:"AA==" })).toBeTruthy();
  expect(ResizeMsg.parse({ type:"resize", id:"r1", cols:80, rows:24 })).toBeTruthy();
});
it("StreamMsg accepts optional base64 enc", () => {
  expect(StreamMsg.parse({ type:"stream", id:"r1", seq:0, chunk:"AA==", eof:false, enc:"base64" })).toBeTruthy();
  expect(StreamMsg.parse({ type:"stream", id:"r1", seq:0, chunk:"hi", eof:false }).enc).toBeUndefined();
});
it("acp.open params/result schemas round-trip", () => {
  expect(VERB_PARAMS["acp.open"].parse({ key: "opencode:c52ddf65" })).toEqual({ key: "opencode:c52ddf65" });
  expect(VERB_RESULTS["acp.open"].parse({ sessionId: "acp_1" })).toEqual({ sessionId: "acp_1" });
});
it("acp.open params accept an optional instance discriminator", () => {
  expect(VERB_PARAMS["acp.open"].parse({ key: "opencode:c52ddf65" })).toEqual({ key: "opencode:c52ddf65" });
  expect(VERB_PARAMS["acp.open"].parse({ key: "opencode:c52ddf65", instance: "tab-2" })).toEqual({
    key: "opencode:c52ddf65",
    instance: "tab-2",
  });
});
it("acp.open result echoes instance when the node understands it, and still parses when an old node omits it", () => {
  expect(VERB_RESULTS["acp.open"].parse({ sessionId: "acp_1", instance: "tab-2" })).toEqual({
    sessionId: "acp_1",
    instance: "tab-2",
  });
  expect(VERB_RESULTS["acp.open"].parse({ sessionId: "acp_1" })).toEqual({ sessionId: "acp_1" });
});
it("acp.attach takes a sessionId; acp.close returns ok", () => {
  expect(VERB_PARAMS["acp.attach"].parse({ sessionId: "acp_1" })).toEqual({ sessionId: "acp_1" });
  expect(VERB_PARAMS["acp.close"].parse({ sessionId: "acp_1" })).toEqual({ sessionId: "acp_1" });
  expect(VERB_RESULTS["acp.close"].parse({ ok: true })).toEqual({ ok: true });
});
it("station capabilities accept acp", () => {
  expect(Capability.parse("acp")).toBe("acp");
});
it("matrix.adopt carries a station key AND its database id — the node needs the key, the hub's redemption endpoint needs the id", () => {
  expect(
    VERB_PARAMS["matrix.adopt"].parse({ key: "hermes:writer-quill", stationId: "station_abc123" })
  ).toEqual({ key: "hermes:writer-quill", stationId: "station_abc123" });
});
it("matrix.adopt strips unknown fields — a credential cannot ride along on this channel", () => {
  // A token on this channel would put a credential on the broker.
  expect(
    VERB_PARAMS["matrix.adopt"].parse({ key: "k", stationId: "s", token: "secret" })
  ).toEqual({ key: "k", stationId: "s" });
});
