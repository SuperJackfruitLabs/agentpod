import { test, expect } from "bun:test";
import { InMemoryConnectionManager } from "../../src/services/connection-manager";

test("register/isOnline/unregister + send routes to the registered sink", () => {
  const cm = new InMemoryConnectionManager();
  const sent: unknown[] = [];
  cm.register("node_1", (m) => sent.push(m));
  expect(cm.isOnline("node_1")).toBe(true);
  expect(cm.send("node_1", { type: "ack", ts: 1 })).toBe(true);
  expect(sent).toEqual([{ type: "ack", ts: 1 }]);
  cm.unregister("node_1");
  expect(cm.isOnline("node_1")).toBe(false);
  expect(cm.send("node_1", { type: "ack", ts: 2 })).toBe(false);
});

test("onlineNodeIds returns ids of currently connected nodes", () => {
  const cm = new InMemoryConnectionManager();
  expect(cm.onlineNodeIds()).toEqual([]);
  cm.register("node_1", () => {});
  expect(cm.onlineNodeIds()).toEqual(["node_1"]);
  cm.register("node_2", () => {});
  expect(cm.onlineNodeIds().sort()).toEqual(["node_1", "node_2"]);
  cm.unregister("node_1");
  expect(cm.onlineNodeIds()).toEqual(["node_2"]);
  cm.unregister("node_2");
  expect(cm.onlineNodeIds()).toEqual([]);
});

test("isCurrent is true only for the currently registered send fn", () => {
  const cm = new InMemoryConnectionManager();
  const sendA = () => {};
  const sendB = () => {};
  cm.register("node_x", sendA);
  expect(cm.isCurrent("node_x", sendA)).toBe(true);
  expect(cm.isCurrent("node_x", sendB)).toBe(false);
  // A reconnect replaces the entry — the old socket is no longer current.
  cm.register("node_x", sendB);
  expect(cm.isCurrent("node_x", sendA)).toBe(false);
  expect(cm.isCurrent("node_x", sendB)).toBe(true);
  // Unregistered node: nothing is current.
  cm.unregister("node_x");
  expect(cm.isCurrent("node_x", sendB)).toBe(false);
});
