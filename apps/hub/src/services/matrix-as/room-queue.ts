/**
 * Messages that arrive while a room's agent is still answering.
 *
 * A person does not wait for a reply before typing their next line, and a
 * picture followed by "what's in this image?" is two messages from one
 * thought. The bridge used to refuse the second — "I could not reach this
 * agent: Session is busy" — posted in the agent's own voice, so it read as
 * the agent turning the person away (2026-09-24). Now the message waits, and
 * when the turn ends everything that waited goes to the agent as one turn:
 * the words in the order they were sent, every picture, and the last message
 * as the one the agent's marks go on.
 *
 * I/O is injected, so the ordering rules are testable without a homeserver,
 * a node or a database.
 */

import type { PromptImage } from "./attachments";

export interface QueuedPrompt {
  text: string;
  images: PromptImage[];
  /** The Matrix event the turn answers, for its 👀/✅ marks. */
  eventId?: string;
}

/** What waiting for the agent came to. */
export type FreeOutcome = "idle" | "ended" | "timeout";

/** What an attempt to hand a prompt over came to. */
export type DispatchOutcome = "sent" | "busy";

export interface RoomQueueDeps {
  /** Resolve once the room's agent can take a prompt, or can no longer answer. */
  waitUntilFree(roomId: string): Promise<FreeOutcome>;
  /** Hand the merged prompt over. "busy" puts it back and waits again. */
  dispatch(roomId: string, prompt: QueuedPrompt): Promise<DispatchOutcome>;
  /** The wait ran out: tell the room, in the bridge's voice, what was dropped. */
  giveUp(roomId: string, dropped: number): Promise<void>;
}

/**
 * How many messages one room may hold. Past this the oldest go: a queue that
 * grows without bound is a turn nobody will read.
 */
export const MAX_QUEUED = 20;

/** Everything that waited, as one prompt. */
export function mergeQueued(items: QueuedPrompt[]): QueuedPrompt {
  const text = items
    .map((item) => item.text)
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  const images = items.flatMap((item) => item.images);
  const eventId = [...items].reverse().find((item) => item.eventId)?.eventId;
  return eventId ? { text, images, eventId } : { text, images };
}

export class RoomQueue {
  private readonly waiting = new Map<string, QueuedPrompt[]>();
  private readonly draining = new Set<string>();

  constructor(private readonly deps: RoomQueueDeps) {}

  /** How many messages this room is holding. */
  size(roomId: string): number {
    return this.waiting.get(roomId)?.length ?? 0;
  }

  /**
   * Hold a message until the room's agent is free, then send it.
   *
   * Resolves once the message is in the queue, not once it is sent — the
   * caller is handling an appservice transaction and must not sit on it for
   * the length of someone else's turn.
   */
  enqueue(roomId: string, item: QueuedPrompt): void {
    const items = this.waiting.get(roomId) ?? [];
    items.push(item);
    while (items.length > MAX_QUEUED) items.shift();
    this.waiting.set(roomId, items);
    if (!this.draining.has(roomId)) {
      this.draining.add(roomId);
      void this.drain(roomId).finally(() => this.draining.delete(roomId));
    }
  }

  /** Wait, send, and repeat while more arrives. Never throws. */
  private async drain(roomId: string): Promise<void> {
    for (;;) {
      const outcome = await this.deps.waitUntilFree(roomId).catch((): FreeOutcome => "timeout");
      const batch = this.waiting.get(roomId) ?? [];
      if (batch.length === 0) return;

      if (outcome === "timeout") {
        this.waiting.delete(roomId);
        await this.deps.giveUp(roomId, batch.length).catch(() => {});
        return;
      }

      this.waiting.delete(roomId);
      const sent = await this.deps.dispatch(roomId, mergeQueued(batch)).catch(
        (): DispatchOutcome => "sent"
      );
      if (sent === "busy") {
        // Someone else's prompt got in first. Put ours back ahead of anything
        // that arrived meanwhile, and wait for that turn too.
        const later = this.waiting.get(roomId) ?? [];
        this.waiting.set(roomId, [...batch, ...later]);
        continue;
      }
      if (this.size(roomId) === 0) return;
    }
  }
}
