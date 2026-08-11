# Doors Slice 1 — Relay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An ACP client spawns `apn acp --station <id>` and can hold a conversation with a station on another machine — attach, prompt, receive the response.

**Architecture:** The hub runs the ACP **agent** using the TypeScript SDK's fluent `agent()` API, bound to a WebSocket as its stream; its handlers call the existing `acp-sessions` service. `apn acp` is a Go byte pipe with no protocol knowledge: stdin → socket, socket → stdout. See [the design](../specs/2026-08-11-doors-acp-proxy-design.md).

**Tech Stack:** Bun · Hono · `@agentclientprotocol/sdk@1.3.0` (fluent `agent()`, **not** `AgentSideConnection`) · Go 1.26 · `github.com/coder/websocket`

## Global Constraints

- **`apn acp` parses nothing.** No JSON, no JSON-RPC, no session concept, no protocol version. If it needs to understand a frame, the boundary is wrong.
- **Fluent SDK API only.** `agent()` / `client()`. `AgentSideConnection` and `ClientSideConnection` are deprecated in 1.3.0 and must not gain new call sites.
- **Do not adopt `agentProtocolRouter()` yet** — it is `@experimental` and v2 is a draft. Structure the agent so it can be registered with `.withV1()` later without a rewrite.
- **No new node-agent dependencies.** `go.mod` has exactly two; the pipe needs neither more.
- **Never write the token to disk.** `apn acp` reads `AGENTPOD_TOKEN` from the environment or takes `--token`.
- TDD, per the repo rule: failing test first, and a regression test for every bug fix.
- Hub tests need the pgvector postgres on `:5434` **and** an explicit `DATABASE_URL` — see `TESTING.md`.

### Verified interfaces (do not re-derive)

Hub session service, `apps/hub/src/services/acp-sessions.ts`:

| Function | Signature | Note |
|---|---|---|
| `createSession` | `(userId, stationId, mode) → AcpSessionRow` | 409s if the node cannot host a second session |
| `subscribe` | `(sessionId, cb) → unsubscribe` | `subscribers` is a `Set` — N clients already supported |
| `answerPermission` | `(userId, sessionId, requestSeq, optionId)` | first-answer-wins; second throws `"No pending permission request."` |

SDK, `@agentclientprotocol/sdk@1.3.0`:

- `agent(options?): AgentApp`, chained with `.onRequest(method, handler)` / `.onNotification(...)` / `.onConnect(...)`, finished with `.connect(stream): AgentConnection`.
- `ndJsonStream(...)` adapts a duplex byte stream to the SDK's `Stream`.
- Agent methods live under `AGENT_METHODS` (e.g. `session_new`, `session_load`, `session_prompt`).
- `session/load` **must** stream the whole history back as notifications; it is gated on advertising the `loadSession` capability.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/hub/src/services/acp-agent.ts` | The ACP agent: builds the `AgentApp`, maps handlers onto the session service |
| `apps/hub/src/routes/acp-proxy.ts` | `GET /api/acp/proxy` — WebSocket upgrade, auth, binds the socket to an `AgentApp` |
| `apps/hub/tests/integration/acp-agent.test.ts` | Drives the agent with an in-process ACP client |
| `apps/node-agent/cmd/agentpod-node/acp.go` | `apn acp` — flags, dial, pipe |
| `apps/node-agent/internal/acpproxy/pipe.go` | The duplex copy, testable without a real editor |
| `apps/node-agent/internal/acpproxy/pipe_test.go` | Pipe semantics: both directions, EOF, socket close |

---

### Task 1: The byte pipe (Go, no network)

Pure duplex copy, so the hard part is testable without a socket or an editor.

**Files:**
- Create: `apps/node-agent/internal/acpproxy/pipe.go`, `apps/node-agent/internal/acpproxy/pipe_test.go`

**Interfaces:**
- Consumes: nothing
- Produces: `func Pipe(ctx context.Context, sock io.ReadWriter, in io.Reader, out io.Writer) error` — returns when either side ends

- [ ] **Step 1: Write the failing test**

```go
package acpproxy

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

// rw joins a reader and a writer into one io.ReadWriter, standing in for a socket.
type rw struct {
	io.Reader
	io.Writer
}

func TestPipeCarriesBothDirections(t *testing.T) {
	// Editor → socket
	editorIn := strings.NewReader(`{"jsonrpc":"2.0","method":"initialize"}` + "\n")
	var toSocket bytes.Buffer
	// Socket → editor
	fromSocket := strings.NewReader(`{"jsonrpc":"2.0","result":{}}` + "\n")
	var toEditor bytes.Buffer

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := Pipe(ctx, rw{Reader: fromSocket, Writer: &toSocket}, editorIn, &toEditor); err != nil && err != io.EOF {
		t.Fatalf("Pipe: %v", err)
	}

	if got := toSocket.String(); !strings.Contains(got, `"initialize"`) {
		t.Errorf("editor→socket carried %q", got)
	}
	if got := toEditor.String(); !strings.Contains(got, `"result"`) {
		t.Errorf("socket→editor carried %q", got)
	}
}

func TestPipeReturnsWhenEditorClosesStdin(t *testing.T) {
	// An editor exiting closes stdin; the proxy must return rather than hang,
	// or every abandoned editor leaves a live session on the hub.
	done := make(chan error, 1)
	go func() {
		done <- Pipe(context.Background(),
			rw{Reader: strings.NewReader(""), Writer: io.Discard},
			strings.NewReader(""), io.Discard)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Pipe did not return when both sides ended")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/node-agent && go test ./internal/acpproxy/...`
Expected: build failure — `undefined: Pipe`.

- [ ] **Step 3: Implement**

```go
// Package acpproxy carries ACP frames between an editor's stdio and the hub.
//
// It deliberately understands nothing about ACP. Every protocol decision —
// initialize, capabilities, session/load replay, permissions, version
// negotiation — happens in the hub, where the SDK is. This file moves bytes.
package acpproxy

import (
	"context"
	"io"
)

// Pipe copies in→sock and sock→out until either direction ends or ctx is done.
//
// The first direction to finish ends the call: an editor that exits closes
// stdin, and a hub that drops the session closes the socket. Either way the
// process should exit rather than linger holding a session open.
func Pipe(ctx context.Context, sock io.ReadWriter, in io.Reader, out io.Writer) error {
	errc := make(chan error, 2)

	go func() {
		_, err := io.Copy(sock, in) // editor → hub
		errc <- err
	}()
	go func() {
		_, err := io.Copy(out, sock) // hub → editor
		errc <- err
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/acpproxy/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/acpproxy
git commit -m "feat(node-agent): acp proxy byte pipe

Understands nothing about ACP by design — the protocol lives in the hub, next
to its SDK. Returns when either side ends so an abandoned editor does not leave
a session live."
```

---

### Task 2: The hub's ACP agent — initialize and session/new

**Files:**
- Create: `apps/hub/src/services/acp-agent.ts`
- Create: `apps/hub/tests/integration/acp-agent.test.ts`

**Interfaces:**
- Consumes: `createSession` from `acp-sessions`
- Produces: `buildAcpAgent(opts: { userId: string; stationId: string }): AgentApp`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { client } from "@agentclientprotocol/sdk";
import { buildAcpAgent } from "../../src/services/acp-agent";

describe("hub ACP agent", () => {
  test("advertises the loadSession capability", async () => {
    // Doors exists to attach to a station's EXISTING session. An agent that
    // cannot load one gives an editor a blank pane and a fresh conversation,
    // which is not the product.
    const app = buildAcpAgent({ userId: "usr_1", stationId: "station_1" });
    const conn = client().connect(app);
    const res = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(res.agentCapabilities?.loadSession).toBe(true);
  });

  test("session/new opens a session on the station", async () => {
    const app = buildAcpAgent({ userId: "usr_1", stationId: "station_1" });
    const conn = client().connect(app);
    await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const res = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
    expect(res.sessionId).toMatch(/^acps_/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/acp-agent.test.ts`
Expected: FAIL — cannot resolve `buildAcpAgent`.

- [ ] **Step 3: Implement**

```ts
/**
 * The hub as an ACP agent.
 *
 * Editors spawn a process and speak ACP over its stdio; `apn acp` is that
 * process and pipes the bytes here. Every protocol decision happens in this
 * file, where the SDK is.
 *
 * Uses the fluent `agent()` API. `AgentSideConnection` is deprecated in SDK
 * 1.3.0 and must not gain new call sites.
 */
import { agent, AGENT_METHODS, type AgentApp } from "@agentclientprotocol/sdk";
import * as sessions from "./acp-sessions";

export interface AcpAgentOptions {
  userId: string;
  stationId: string;
}

export function buildAcpAgent(opts: AcpAgentOptions): AgentApp {
  return agent({ name: "agentpod" })
    .onRequest(AGENT_METHODS.initialize, async () => ({
      protocolVersion: 1,
      agentCapabilities: {
        // Doors attaches to existing sessions; without this an editor can only
        // ever start a fresh conversation.
        loadSession: true,
      },
    }))
    .onRequest(AGENT_METHODS.session_new, async () => {
      const row = await sessions.createSession(opts.userId, opts.stationId, "ask");
      return { sessionId: row.id };
    });
}
```

- [ ] **Step 4: Run the tests**

Run: `DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/acp-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/acp-agent.ts apps/hub/tests/integration/acp-agent.test.ts
git commit -m "feat(hub): ACP agent surface — initialize and session/new

Fluent agent() API, not the deprecated AgentSideConnection. Advertises
loadSession because attaching to an existing session is the point of Doors."
```

---

### Task 3: `session/prompt` and streaming the response back

**Files:**
- Modify: `apps/hub/src/services/acp-agent.ts`
- Modify: `apps/hub/tests/integration/acp-agent.test.ts`

**Interfaces:**
- Consumes: `sessions.subscribe`, `sessions.prompt`
- Produces: the same `buildAcpAgent`, now handling `session/prompt`

- [ ] **Step 1: Write the failing test**

```ts
test("session/prompt forwards to the station and streams updates back", async () => {
  const app = buildAcpAgent({ userId: "usr_1", stationId: "station_1" });
  const updates: unknown[] = [];
  const conn = client()
    .onNotification("session/update", async (params) => { updates.push(params); })
    .connect(app);

  await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
  await conn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

  expect(updates.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — no handler registered for `session/prompt`.

- [ ] **Step 3: Implement**

Add to the chain in `buildAcpAgent`, before the final return:

```ts
    .onRequest(AGENT_METHODS.session_prompt, async (params, ctx) => {
      // Subscribe BEFORE prompting: the agent can emit its first update before
      // prompt() resolves, and a late subscriber silently drops it.
      const unsubscribe = sessions.subscribe(params.sessionId, (event) => {
        void ctx.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: event.payload as Record<string, unknown>,
        });
      });
      try {
        await sessions.prompt(opts.userId, params.sessionId, textOf(params.prompt));
        return { stopReason: "end_turn" };
      } finally {
        unsubscribe();
      }
    })
```

with:

```ts
/** ACP prompts are content blocks; the session service takes text. */
function textOf(blocks: Array<{ type: string; text?: string }>): string {
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}
```

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub
git commit -m "feat(hub): ACP session/prompt with streamed updates

Subscribes before prompting — the agent can emit its first update before
prompt() resolves, and a late subscriber drops it silently."
```

---

### Task 4: The proxy WebSocket route

**Files:**
- Create: `apps/hub/src/routes/acp-proxy.ts`
- Modify: `apps/hub/src/index.ts` (mount the route)

**Interfaces:**
- Consumes: `buildAcpAgent`
- Produces: `GET /api/acp/proxy?station=<id>` — upgrades, authenticates, binds socket to agent

- [ ] **Step 1: Write the failing test**

```ts
test("proxy route rejects an unauthenticated upgrade", async () => {
  const res = await app.request("/api/acp/proxy?station=station_1");
  expect(res.status).toBe(401);
});

test("proxy route requires a station", async () => {
  const res = await app.request("/api/acp/proxy", { headers: authHeaders() });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — route not mounted, 404 rather than 401/400.

- [ ] **Step 3: Implement**

```ts
/**
 * GET /api/acp/proxy?station=<id>[&session=<id>]
 *
 * Upgrades to a WebSocket carrying raw ACP frames, and binds it to a hub-side
 * ACP agent. `apn acp` sits on the other end piping an editor's stdio.
 *
 * Auth mirrors every other hub route: authMiddleware accepts a bearer or the
 * `?token=` query, which is how a WebSocket handshake authenticates at all.
 */
import { Hono } from "hono";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { buildAcpAgent } from "../services/acp-agent";
import type { AuthUser } from "../auth/middleware";

export const acpProxyRouter = new Hono().get("/acp/proxy", async (c) => {
  const user = c.get("user") as AuthUser | undefined;
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const stationId = c.req.query("station");
  if (!stationId) return c.json({ error: "station is required" }, 400);

  const { response, socket } = upgradeWebSocket(c);
  const stream = ndJsonStream(socketToDuplex(socket));
  buildAcpAgent({ userId: user.id, stationId }).connect(stream);
  return response;
});
```

Use the same upgrade helper the terminal and session WS routes already use, rather than a new one — match `station-acp.ts`.

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub
git commit -m "feat(hub): /api/acp/proxy — WebSocket carrying raw ACP frames"
```

---

### Task 5: The `apn acp` subcommand

**Files:**
- Create: `apps/node-agent/cmd/agentpod-node/acp.go`
- Modify: `apps/node-agent/cmd/agentpod-node/main.go` (dispatch), `help.go` (entry)

**Interfaces:**
- Consumes: `acpproxy.Pipe`
- Produces: `apn acp --station <id> [--hub <url>] [--session <id>]`

- [ ] **Step 1: Write the failing test**

```go
func TestAcpRequiresStationOrSession(t *testing.T) {
	// Guessing which station an editor meant is worse than refusing.
	if err := acpArgsValid("", ""); err == nil {
		t.Error("expected an error when neither --station nor --session is given")
	}
	if err := acpArgsValid("station_1", ""); err != nil {
		t.Errorf("--station alone should be valid: %v", err)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./cmd/agentpod-node/ -run TestAcpRequires`
Expected: build failure — `undefined: acpArgsValid`.

- [ ] **Step 3: Implement**

```go
func acpArgsValid(station, session string) error {
	if station == "" && session == "" {
		return errors.New("apn acp: one of --station or --session is required")
	}
	return nil
}

func acpCmd(args []string) {
	fs := flag.NewFlagSet("acp", flag.ExitOnError)
	station := fs.String("station", "", "station to attach to")
	session := fs.String("session", "", "specific session to resume")
	hub := fs.String("hub", "https://hub.agentpod.dev", "hub base URL")
	token := fs.String("token", os.Getenv("AGENTPOD_TOKEN"), "hub token (prefer AGENTPOD_TOKEN)")
	_ = fs.Parse(args)

	if err := acpArgsValid(*station, *session); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *token == "" {
		fmt.Fprintln(os.Stderr, "apn acp: set AGENTPOD_TOKEN or pass --token")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	conn, err := acpproxy.Dial(ctx, *hub, *token, *station, *session)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apn acp: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	if err := acpproxy.Pipe(ctx, conn, os.Stdin, os.Stdout); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintf(os.Stderr, "apn acp: %v\n", err)
		os.Exit(1)
	}
}
```

`acpproxy.Dial` wraps `websocket.Dial` with the bearer header and `?station=`/`?session=`, mirroring `internal/gateway/client.go`'s URL derivation.

- [ ] **Step 4: Run the tests**

Run: `go test -race ./cmd/... ./internal/acpproxy/...`
Expected: PASS.

- [ ] **Step 5: Add the help entry and dispatch**

Mirror the `scan` entry in `help.go` (group `Node`) and add `case "acp":` to `main.go`, calling `maybeShowHelp` first like every other subcommand.

- [ ] **Step 6: Commit**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): apn acp — pipe an editor's stdio to a hub station"
```

---

### Task 6: End-to-end against a real station

**Files:** none — this is verification, per the repo rule that fleet-touching work is checked against the real deployment.

- [ ] **Step 1: Drive it by hand**

```bash
AGENTPOD_TOKEN=… apn acp --station station_f4693267-9ce9-407b-8565-14f5c11f6a87 <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
EOF
```

Expected: a JSON-RPC result on stdout advertising `loadSession`. This proves the whole path — Go pipe, WSS, hub agent, SDK — without an editor.

- [ ] **Step 2: Drive it from a real editor**

Point Zed at `apn acp --station <id>` as a custom agent, send one prompt, confirm the reply. This is the acceptance criterion for the slice: the console is no longer the only way in.

- [ ] **Step 3: Record what the editor did with an existing session**

Attach to a station whose session already has history and note whether the editor renders it. The protocol says `session/load` streams history back, but slice 1 only implements `session/new` — so the expected result is a fresh conversation, and confirming that is what scopes slice 2.

- [ ] **Step 4: Commit the finding**

```bash
git commit --allow-empty -m "docs: Doors slice 1 verified against a real station from a real editor"
```

---

## Self-Review

**Spec coverage:** byte pipe → Task 1. Hub ACP agent → Tasks 2–3. `loadSession` advertisement → Task 2 (the capability; the handler is slice 2). Proxy route and auth → Task 4. `apn acp` and session selection → Task 5. Live verification → Task 6. Concurrent attach, permissions, cancel and mode are **slice 2 and 3** and deliberately absent here.

**Placeholder scan:** every code step carries real code. The one hand-wave is `upgradeWebSocket`/`socketToDuplex` in Task 4, which Step 3 explicitly directs to the existing helper in `station-acp.ts` rather than inventing one — flagged rather than hidden.

**Type consistency:** `buildAcpAgent(opts)` keeps its signature across Tasks 2–4. `Pipe(ctx, sock, in, out)` is unchanged between Tasks 1 and 5. `acpArgsValid(station, session)` is defined and used in Task 5 only.
