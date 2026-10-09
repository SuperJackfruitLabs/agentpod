import { describe, it, expect } from "bun:test";
import { VERB_PARAMS, VERB_RESULTS, InputMsg, ResizeMsg, StreamMsg, RequestMsg } from "./protocol";
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
it("matrix.adopt's RESULT carries the mxid the node read back — the move has no other trigger", () => {
  // The whole-branch review's Critical: `matrix.adopt` restarts the harness,
  // not the node-agent, so no detect ever follows it and nothing else on the
  // node→hub channel carries an mxid. This field is the trigger.
  expect(
    VERB_RESULTS["matrix.adopt"].parse({
      accepted: true,
      matrixId: "@agent_writer-quill:id.agentpod.dev",
    })
  ).toEqual({ accepted: true, matrixId: "@agent_writer-quill:id.agentpod.dev" });
});
it("matrix.adopt's result accepts a null mxid, and one from a node that predates the field", () => {
  // null: the write landed somewhere the real reader does not look — the §3
  // failure. Absent: an older node. Both are "nothing converged", never a
  // parse failure that would lose the `accepted` half too.
  expect(VERB_RESULTS["matrix.adopt"].parse({ accepted: true, matrixId: null })).toEqual({
    accepted: true,
    matrixId: null,
  });
  expect(VERB_RESULTS["matrix.adopt"].parse({ accepted: true })).toEqual({ accepted: true });
});
it("matrix.adopt's result strips unknown fields — the credential does not come back either", () => {
  expect(
    VERB_RESULTS["matrix.adopt"].parse({ accepted: true, matrixId: "@a:h", accessToken: "syt_x" })
  ).toEqual({ accepted: true, matrixId: "@a:h" });
});
it("transcription.apply carries a station key AND its database id — the node needs the key, the hub's config endpoint needs the id", () => {
  expect(
    VERB_PARAMS["transcription.apply"].parse({ key: "hermes:analyst-echo", stationId: "station_abc123" })
  ).toEqual({ key: "hermes:analyst-echo", stationId: "station_abc123" });
});
it("transcription.apply strips unknown fields — an API key cannot ride along on this channel", () => {
  expect(
    VERB_PARAMS["transcription.apply"].parse({
      key: "k",
      stationId: "s",
      apiKey: "sk-secret",
      url: "http://stt.internal:8840",
    })
  ).toEqual({ key: "k", stationId: "s" });
});
it("transcription.apply's result says what the profile now holds and whether the harness restarted", () => {
  expect(
    VERB_RESULTS["transcription.apply"].parse({ applied: true, mode: "on", model: "large-v3-turbo", restarted: true })
  ).toEqual({ applied: true, mode: "on", model: "large-v3-turbo", restarted: true });
  expect(
    VERB_RESULTS["transcription.apply"].parse({ applied: true, mode: "off", model: null, restarted: false })
  ).toEqual({ applied: true, mode: "off", model: null, restarted: false });
  expect(() =>
    VERB_RESULTS["transcription.apply"].parse({ applied: true, mode: "maybe", model: null, restarted: false })
  ).toThrow();
});
it("transcription.apply's result strips unknown fields — neither the key nor the url comes back", () => {
  expect(
    VERB_RESULTS["transcription.apply"].parse({
      applied: true,
      mode: "on",
      model: "m",
      restarted: true,
      apiKey: "sk-secret",
      url: "http://stt.internal:8840/v1",
    })
  ).toEqual({ applied: true, mode: "on", model: "m", restarted: true });
});

it("speech.apply carries a station key AND its database id, and nothing else", () => {
  expect(
    VERB_PARAMS["speech.apply"].parse({
      key: "hermes:writer-quill",
      stationId: "station_abc123",
      apiKey: "sk-secret",
      url: "http://speech.internal:8841",
      voice: "af_heart",
    })
  ).toEqual({ key: "hermes:writer-quill", stationId: "station_abc123" });
  expect(() => VERB_PARAMS["speech.apply"].parse({ key: "k" })).toThrow();
});
it("speech.apply's result says what the profile now speaks with, when, and whether it restarted", () => {
  const on = {
    applied: true,
    mode: "on",
    voice: "af_heart:60+af_bella:40",
    speakMode: "voice_in",
    autoSpeak: false,
    restarted: true,
  };
  expect(VERB_RESULTS["speech.apply"].parse(on)).toEqual(on);
  const off = { applied: true, mode: "off", voice: null, speakMode: null, autoSpeak: false, restarted: false };
  expect(VERB_RESULTS["speech.apply"].parse(off)).toEqual(off);
  expect(() => VERB_RESULTS["speech.apply"].parse({ ...on, mode: "maybe" })).toThrow();
  expect(() => VERB_RESULTS["speech.apply"].parse({ ...on, speakMode: "sometimes" })).toThrow();
  expect(() => VERB_RESULTS["speech.apply"].parse({ ...on, autoSpeak: undefined })).toThrow();
});
it("speech.apply's result strips unknown fields — neither the key nor the url comes back", () => {
  expect(
    VERB_RESULTS["speech.apply"].parse({
      applied: true,
      mode: "on",
      voice: "af_heart",
      speakMode: "always",
      autoSpeak: true,
      restarted: true,
      apiKey: "sk-secret",
      url: "http://speech.internal:8841/v1",
    })
  ).toEqual({ applied: true, mode: "on", voice: "af_heart", speakMode: "always", autoSpeak: true, restarted: true });
});

it("matrix.avatar.set names a station and a workspace image — nothing else rides along", () => {
  expect(
    VERB_PARAMS["matrix.avatar.set"].parse({ key: "hermes:coder-kai", path: "pfp.png", accessToken: "syt_x" })
  ).toEqual({ key: "hermes:coder-kai", path: "pfp.png" });
});
it("matrix.avatar.set's result is the identity and the uploaded image, never the credential", () => {
  expect(
    VERB_RESULTS["matrix.avatar.set"].parse({
      matrixId: "@agent_coder-kai:id.agentpod.dev",
      mxc: "mxc://id.agentpod.dev/abc",
      accessToken: "syt_x",
    })
  ).toEqual({ matrixId: "@agent_coder-kai:id.agentpod.dev", mxc: "mxc://id.agentpod.dev/abc" });
  expect(() => VERB_RESULTS["matrix.avatar.set"].parse({ matrixId: "@a:h", mxc: "https://x" })).toThrow();
});

describe("git identity verbs", () => {
  // The rule these verbs exist to keep: nothing secret crosses the broker. The private half of the
  // key is generated on the node and never leaves it, so neither schema has anywhere to put one.
  it("neither the params nor the result has a field a secret could ride in", () => {
    for (const verb of ["git.identity.ensure", "git.identity.remove"] as const) {
      const params = Object.keys(VERB_PARAMS[verb].shape);
      const result = Object.keys(VERB_RESULTS[verb].shape);
      for (const field of [...params, ...result]) {
        expect(field).not.toMatch(/token|secret|private|password|keyPath/i);
      }
    }
  });

  it("ensure carries BOTH names of the station, because neither side knows the other's", () => {
    // stationId alone cannot be looked up by the node's spawn path; stationKey alone cannot survive
    // a rename. Dropping either one breaks a push with nothing to explain it.
    expect(VERB_PARAMS["git.identity.ensure"].safeParse({ stationId: "stn_a" }).success).toBe(false);
    expect(VERB_PARAMS["git.identity.ensure"].safeParse({ stationKey: "hermes:a" }).success).toBe(false);
    expect(
      VERB_PARAMS["git.identity.ensure"].safeParse({ stationId: "stn_a", stationKey: "hermes:a" })
        .success,
    ).toBe(true);
  });

  it("ensure may carry the commit author, and stays valid without one so older hubs still work", () => {
    const base = { stationId: "stn_a", stationKey: "hermes:a" };
    const author = { name: "Fixture Agent", email: "fixture-agent@agents.example" };
    expect(VERB_PARAMS["git.identity.ensure"].parse({ ...base, author }).author).toEqual(author);
    expect(VERB_PARAMS["git.identity.ensure"].parse(base).author).toBeUndefined();
  });

  it("an author is both a name and an email, never half of one", () => {
    // A commit with an author name and the host's email (or the reverse) is attributed to nobody.
    const base = { stationId: "stn_a", stationKey: "hermes:a" };
    for (const author of [
      { name: "Fixture Agent" },
      { email: "fixture-agent@agents.example" },
      { name: "", email: "fixture-agent@agents.example" },
      { name: "Fixture Agent", email: "" },
    ]) {
      expect(VERB_PARAMS["git.identity.ensure"].safeParse({ ...base, author }).success).toBe(false);
    }
  });

  it("remove is keyed by id alone, so a rename cannot make it miss", () => {
    expect(VERB_PARAMS["git.identity.remove"].safeParse({ stationId: "stn_a" }).success).toBe(true);
  });

  it("the result reports whether a key was minted, which is what makes a re-provision safe", () => {
    expect(
      VERB_RESULTS["git.identity.ensure"].safeParse({ publicKey: "ssh-ed25519 AAAA", created: true })
        .success,
    ).toBe(true);
    expect(VERB_RESULTS["git.identity.ensure"].safeParse({ publicKey: "ssh-ed25519 AAAA" }).success).toBe(false);
  });
});

it("RequestMsg carries an optional trace _meta (C2), and stays valid without one", () => {
  const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  expect(RequestMsg.parse({ type: "req", id: "1", verb: "acp.open", params: {}, _meta: { traceparent: tp } })._meta).toEqual({
    traceparent: tp,
  });
  expect(RequestMsg.parse({ type: "req", id: "1", verb: "x", params: {} })._meta).toBeUndefined();
});
it("fs.read takes an offset and echoes offset/size/eof; an old result still parses", () => {
  expect(VERB_PARAMS["fs.read"].parse({ key: "k", path: "a", offset: 4 }).offset).toBe(4);
  expect(() => VERB_PARAMS["fs.read"].parse({ key: "k", path: "a", offset: -1 })).toThrow();
  const r = VERB_RESULTS["fs.read"].parse({ content: "AA==", encoding: "base64", truncated: true, offset: 4, size: 10, eof: false });
  expect([r.offset, r.size, r.eof]).toEqual([4, 10, false]);
  expect(VERB_RESULTS["fs.read"].parse({ content: "x", encoding: "utf8", truncated: false }).offset).toBeUndefined();
});

it("fs.walk takes caps within the folder limits and returns a manifest", () => {
  expect(VERB_PARAMS["fs.walk"].parse({ key: "k", path: "site", maxFiles: 500 }).maxFiles).toBe(500);
  expect(() => VERB_PARAMS["fs.walk"].parse({ key: "k", path: "site", maxFiles: 501 })).toThrow();
  expect(() => VERB_PARAMS["fs.walk"].parse({ key: "k", path: "site", maxBytes: 100 * 1024 * 1024 + 1 })).toThrow();
  const r = VERB_RESULTS["fs.walk"].parse({ root: "site", files: [{ path: "", size: 3 }], skipped: [{ path: "x", reason: "symlink" }, { path: "y", reason: "unreadable" }], tooMany: false, tooLarge: false });
  expect(r.files[0]!.size).toBe(3);
  expect(() => VERB_RESULTS["fs.walk"].parse({ root: "s", files: [], skipped: [{ path: "x", reason: "other" }], tooMany: false, tooLarge: false })).toThrow();
});

it("fs.walk says which limit truncated it, and an old result without the field still parses", () => {
  const base = { root: "s", files: [], skipped: [], tooMany: true, tooLarge: false };
  expect(VERB_RESULTS["fs.walk"].parse({ ...base, truncatedBy: "skipped" }).truncatedBy).toBe("skipped");
  expect(VERB_RESULTS["fs.walk"].parse(base).truncatedBy).toBeUndefined();
  expect(() => VERB_RESULTS["fs.walk"].parse({ ...base, truncatedBy: "other" })).toThrow();
});
