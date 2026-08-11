import { describe, expect, test } from "bun:test";
import { webSocketStream } from "../../src/services/acp-ws-stream";

const dec = new TextDecoder();

/** Collects everything the "socket" was asked to send. */
function sink() {
  const sent: string[] = [];
  return { sent, send: (d: string) => void sent.push(d) };
}

describe("webSocketStream", () => {
  test("frames written by the agent reach the socket as ndjson", async () => {
    const s = sink();
    const { stream } = webSocketStream(s);

    const w = stream.writable.getWriter();
    await w.write({ jsonrpc: "2.0", id: 1, result: {} } as never);
    await w.close();

    expect(s.sent).toHaveLength(1);
    expect(JSON.parse(s.sent[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    // ndjson: exactly one trailing newline, so a reader can split on it.
    expect(s.sent[0]!.endsWith("\n")).toBe(true);
  });

  test("frames pushed from the socket reach the agent", async () => {
    const { stream, push } = webSocketStream(sink());

    push(`{"jsonrpc":"2.0","id":1,"method":"initialize"}` + "\n");

    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value).toMatchObject({ method: "initialize" });
  });

  test("a frame split across two socket messages is reassembled", async () => {
    // WebSocket message boundaries are not JSON boundaries. A proxy piping raw
    // bytes can split a frame anywhere, and treating each message as a whole
    // frame would corrupt the stream under load.
    const { stream, push } = webSocketStream(sink());

    push(`{"jsonrpc":"2.0","id":7,"me`);
    push(`thod":"session/new"}` + "\n");

    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value).toMatchObject({ id: 7, method: "session/new" });
  });

  test("two frames in one socket message both arrive", async () => {
    const { stream, push } = webSocketStream(sink());

    push(`{"jsonrpc":"2.0","id":1,"method":"a"}` + "\n" + `{"jsonrpc":"2.0","id":2,"method":"b"}` + "\n");

    const reader = stream.readable.getReader();
    expect((await reader.read()).value).toMatchObject({ id: 1 });
    expect((await reader.read()).value).toMatchObject({ id: 2 });
  });

  test("close ends the input stream so the agent stops waiting", async () => {
    const { stream, close } = webSocketStream(sink());
    close();

    const reader = stream.readable.getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  test("sending after the socket closed does not throw", async () => {
    // The agent may still be mid-turn when the editor disappears. A throw here
    // would surface as an unhandled rejection in the hub rather than a closed
    // session.
    const s = { send: () => { throw new Error("socket is closed"); } };
    const { stream } = webSocketStream(s);

    const w = stream.writable.getWriter();
    await w.write({ jsonrpc: "2.0", id: 1, result: {} } as never);
    // Reaching here without throwing is the assertion.
    expect(true).toBe(true);
  });
});
