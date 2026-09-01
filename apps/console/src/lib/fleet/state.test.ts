import { describe, expect, it } from "vitest";
import {
  STATE,
  STATE_ORDER,
  stationState,
  nodeState,
  runtimeState,
  sessionState,
} from "./state";

describe("STATE_ORDER", () => {
  it("is worst-first", () => {
    expect(STATE_ORDER).toEqual(["error", "unknown", "starting", "running", "sleeping", "stopped"]);
  });
});

describe("stationState", () => {
  it("maps running", () => {
    expect(stationState("running")).toBe(STATE.running);
  });

  it("maps stopped", () => {
    expect(stationState("stopped")).toBe(STATE.stopped);
  });

  it("maps error", () => {
    expect(stationState("error")).toBe(STATE.error);
  });

  it("maps unknown", () => {
    expect(stationState("unknown")).toBe(STATE.unknown);
  });

  it("falls back to unknown for anything else", () => {
    expect(stationState("degraded")).toBe(STATE.unknown);
    expect(stationState("")).toBe(STATE.unknown);
    expect(stationState("bogus")).toBe(STATE.unknown);
  });
});

describe("nodeState", () => {
  it("maps online to running", () => {
    expect(nodeState("online")).toBe(STATE.running);
  });

  it("maps offline to error", () => {
    expect(nodeState("offline")).toBe(STATE.error);
  });

  it("falls back to unknown for anything else", () => {
    expect(nodeState("bogus")).toBe(STATE.unknown);
    expect(nodeState("")).toBe(STATE.unknown);
  });
});

describe("runtimeState", () => {
  it("maps provisioning, starting, stopping to starting", () => {
    expect(runtimeState("provisioning")).toBe(STATE.starting);
    expect(runtimeState("starting")).toBe(STATE.starting);
    expect(runtimeState("stopping")).toBe(STATE.starting);
  });

  it("maps online to running", () => {
    expect(runtimeState("online")).toBe(STATE.running);
  });

  it("maps stopped and destroyed to stopped", () => {
    expect(runtimeState("stopped")).toBe(STATE.stopped);
    expect(runtimeState("destroyed")).toBe(STATE.stopped);
  });

  it("maps asleep to sleeping", () => {
    expect(runtimeState("asleep")).toBe(STATE.sleeping);
  });

  it("maps error to error", () => {
    expect(runtimeState("error")).toBe(STATE.error);
  });

  it("falls back to unknown for anything else", () => {
    expect(runtimeState("bogus")).toBe(STATE.unknown);
    expect(runtimeState("")).toBe(STATE.unknown);
  });
});

describe("sessionState", () => {
  it("maps starting to starting", () => {
    expect(sessionState("starting")).toBe(STATE.starting);
  });

  it("maps idle to stopped", () => {
    expect(sessionState("idle")).toBe(STATE.stopped);
  });

  it("maps working to running", () => {
    expect(sessionState("working")).toBe(STATE.running);
  });

  it("maps waiting to unknown", () => {
    expect(sessionState("waiting")).toBe(STATE.unknown);
  });

  it("maps ended to stopped", () => {
    expect(sessionState("ended")).toBe(STATE.stopped);
  });

  it("falls back to unknown for anything else", () => {
    expect(sessionState("bogus")).toBe(STATE.unknown);
    expect(sessionState("")).toBe(STATE.unknown);
  });
});
