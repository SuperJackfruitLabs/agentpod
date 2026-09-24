import { describe, expect, test } from "bun:test";
import { MAX_QUEUED, RoomQueue, mergeQueued, type QueuedPrompt } from "./room-queue";

const ROOM = "!room:id.agentpod.dev";
const image = { mimeType: "image/png", data: "AAAA", name: "map.png", bytes: 3 };

/** A queue whose "agent" becomes free when the test says so. */
function rig(opts: { busyTimes?: number } = {}) {
  let release: ((v: "idle" | "ended" | "timeout") => void) | null = null;
  const sent: QueuedPrompt[] = [];
  const gaveUp: number[] = [];
  let busy = opts.busyTimes ?? 0;
  const queue = new RoomQueue({
    waitUntilFree: () => new Promise((r) => (release = r)),
    dispatch: async (_room, prompt) => {
      if (busy > 0) {
        busy -= 1;
        return "busy";
      }
      sent.push(prompt);
      return "sent";
    },
    giveUp: async (_room, dropped) => {
      gaveUp.push(dropped);
    },
  });
  const free = async (how: "idle" | "ended" | "timeout" = "idle") => {
    const r = release;
    release = null;
    r?.(how);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { queue, sent, gaveUp, free };
}

describe("mergeQueued", () => {
  test("the words in order, every picture, the last message's event", () => {
    expect(
      mergeQueued([
        { text: "", images: [image], eventId: "$pic" },
        { text: "What's in this image?", images: [], eventId: "$q" },
      ])
    ).toEqual({ text: "What's in this image?", images: [image], eventId: "$q" });
  });

  test("several lines become one prompt, a paragraph each", () => {
    expect(
      mergeQueued([
        { text: "One more thing", images: [] },
        { text: "and make it short", images: [], eventId: "$2" },
      ]).text
    ).toBe("One more thing\n\nand make it short");
  });
});

describe("RoomQueue", () => {
  test("a message that arrived mid-turn is sent when the turn ends, not refused", async () => {
    const { queue, sent, free } = rig();
    queue.enqueue(ROOM, { text: "What's in this image?", images: [], eventId: "$q" });
    expect(sent).toHaveLength(0);
    await free();
    expect(sent).toEqual([{ text: "What's in this image?", images: [], eventId: "$q" }]);
    expect(queue.size(ROOM)).toBe(0);
  });

  test("everything that waited goes as one turn", async () => {
    const { queue, sent, free } = rig();
    queue.enqueue(ROOM, { text: "first", images: [], eventId: "$1" });
    queue.enqueue(ROOM, { text: "second", images: [image], eventId: "$2" });
    await free();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ text: "first\n\nsecond", images: [image], eventId: "$2" });
  });

  test("an ended session still gets the message — the dispatcher opens a new one", async () => {
    const { queue, sent, free } = rig();
    queue.enqueue(ROOM, { text: "hello?", images: [] });
    await free("ended");
    expect(sent).toHaveLength(1);
  });

  test("losing the race to another prompt puts the batch back and waits again", async () => {
    const { queue, sent, free } = rig({ busyTimes: 1 });
    queue.enqueue(ROOM, { text: "mine", images: [], eventId: "$m" });
    await free(); // busy again: someone else's prompt got in
    expect(sent).toHaveLength(0);
    expect(queue.size(ROOM)).toBe(1);
    await free();
    expect(sent).toEqual([{ text: "mine", images: [], eventId: "$m" }]);
  });

  test("a turn that never ends drops the queue with a word to the room, not silence", async () => {
    const { queue, sent, gaveUp, free } = rig();
    queue.enqueue(ROOM, { text: "a", images: [] });
    queue.enqueue(ROOM, { text: "b", images: [] });
    await free("timeout");
    expect(sent).toHaveLength(0);
    expect(gaveUp).toEqual([2]);
    expect(queue.size(ROOM)).toBe(0);
  });

  test("a room holds at most MAX_QUEUED, dropping the oldest", async () => {
    const { queue, sent, free } = rig();
    for (let i = 0; i < MAX_QUEUED + 5; i++) queue.enqueue(ROOM, { text: `m${i}`, images: [] });
    expect(queue.size(ROOM)).toBe(MAX_QUEUED);
    await free();
    expect(sent[0]!.text.startsWith("m5")).toBe(true);
  });

  test("rooms queue independently", async () => {
    const { queue } = rig();
    queue.enqueue(ROOM, { text: "a", images: [] });
    queue.enqueue("!other:id.agentpod.dev", { text: "b", images: [] });
    expect(queue.size(ROOM)).toBe(1);
    expect(queue.size("!other:id.agentpod.dev")).toBe(1);
  });
});
