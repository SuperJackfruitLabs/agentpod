/**
 * Adapts a Bun/Hono WebSocket to the ACP SDK's `Stream`.
 *
 * The SDK speaks newline-delimited JSON over a pair of byte streams — the shape
 * it uses for stdio. Doors carries exactly those bytes over a WebSocket, since
 * `apn acp` pipes an editor's stdio without parsing it. This module is the only
 * place the two representations meet.
 *
 * The subtle part is framing: **WebSocket message boundaries are not JSON
 * boundaries.** A proxy piping raw bytes can split a frame anywhere and can
 * coalesce several into one message. `ndJsonStream` handles that correctly as
 * long as we hand it a faithful byte stream rather than pretending each socket
 * message is a whole frame.
 */

import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

/** The minimum a socket must offer. Kept tiny so tests need no real socket. */
export interface WsSink {
  send(data: string): void;
}

export interface WebSocketStream {
  stream: Stream;
  /** Feed bytes that arrived on the socket. Safe to call with partial frames. */
  push(chunk: string): void;
  /** The socket closed; end the agent's input so it stops waiting. */
  close(): void;
}

export function webSocketStream(sink: WsSink): WebSocketStream {
  const encoder = new TextEncoder();

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;

  const input = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      try {
        sink.send(new TextDecoder().decode(chunk));
      } catch {
        // The editor can vanish mid-turn. A throw here would surface as an
        // unhandled rejection inside the hub rather than a closed session, so
        // the write is dropped and the close path does the tidying.
      }
    },
  });

  return {
    stream: ndJsonStream(output, input),
    push(chunk: string) {
      if (closed) return;
      controller?.enqueue(encoder.encode(chunk));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
      } catch {
        // Already closed by the stream itself.
      }
    },
  };
}
