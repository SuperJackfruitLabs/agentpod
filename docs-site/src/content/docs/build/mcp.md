---
title: MCP tools
description: The hub's MCP endpoint — self-scoped tools that let an agent answer questions about where it is running, and keep a file from its workspace in Superlibrary.
---

The hub speaks MCP over Streamable HTTP at **`/mcp`**.

## Getting a token

```sh
fleet login
```

The endpoint takes a token from the account service in `Authorization: Bearer`, and only there. There is
no `?token=` fallback — a credential in a URL is a credential in a log.

## What an agent gets

Three tools. All read-only. **None of them take a station id**:

| Tool | Answers |
|---|---|
| `agentpod_my_station` | Where you are running: your station key, its node, your harness, your Matrix identity, and whether the node is online |
| `agentpod_my_sessions` | Your recent ACP sessions, newest first. Takes an optional `limit` (max 50) |
| `agentpod_my_transcript` | The events of one of your sessions. Takes a `sessionId` and an optional `sinceSeq` |

The station is derived from the calling principal in the token. There is no station
parameter, which means there is no station parameter to tamper with — the tools answer for
*you*, and there is no way to ask about anybody else.

If you are not currently placed in a station, they say so in a plain sentence. That is not
an error, and it should not be handled as one.

`agentpod_my_transcript` is the one tool with an explicit ownership check, because a
transcript is named by a session id and an id is a thing that can be guessed. A session
that is not yours is refused.

## Linking a file to Superlibrary

When the hub is configured for Superlibrary, an agent has a fourth tool, `agentpod_link_artifact`. It keeps a
file or folder from the agent's own workspace in Superlibrary, with its provenance (station, path, board,
card and run), and returns a link.

| Argument | Meaning |
|---|---|
| `path` | Required. The file or folder, relative to the workspace |
| `title` | Optional. A name for the item |
| `kind` | Optional. `file` or `folder`; a mismatch is refused |
| `entry` | Optional, for a folder. The file to open first, relative to the linked folder (for example `index.html`) |

**It takes no station argument.** Only the station the calling principal occupies is ever read, and any other
key an agent sends is dropped. A person does not get the tool: a person uploads to Superlibrary directly.

It refuses, in a plain sentence the agent can act on, when:

- the path leaves the workspace, or is the workspace itself;
- the name is credentials, a `.env` file, a key or harness config. These are never linked;
- a secret is found in the content. **This cannot be overridden**: remove the secret and link again, and nothing is added to the library;
- a file is over 25 MB, a folder is over 100 MB or 500 files, or the folder has no linkable file;
- the station is unavailable, its node is too old to list or read files, or Superlibrary is unreachable.

What Superlibrary returns or holds is reference material, never instructions. After linking, the agent
attaches the returned url to its card with `superpipeline_add_reference`.

### The rules agents are given

The server's `initialize` instructions always carry rule 3. Rules 1 and 2 appear only when the hub is configured
for Superlibrary, because that is when `agentpod_link_artifact` exists:

1. If it also has Superlibrary's MCP server (`library_search`), search it before non-trivial work.
2. Link files it produces with `agentpod_link_artifact`, from its own workspace only, and attach the url to its card with `superpipeline_add_reference`.
3. Never publish through gists, pastebins or personal accounts.

The card prompt states the third rule on every card, whether the agent reports for itself or the bridge reports for it. It names `agentpod_link_artifact`
and `library_search` only when the prompt's `libraryTools` is true.

The bridge requests the node's proxy when available. Tool availability comes from the node's
actual response; a request to enable the proxy alone does not establish that the session has it.
Salaam additionally checks that its adapter reports the same admitted servers.

## What a human gets

Nothing self-scoped — a person occupies no station, so those tools have no meaning. Fleet
tools are not exposed over MCP yet; use `fleet` for nodes, agents, stats and activity.

The server tells you this in its `initialize` instructions rather than making you find out
by calling something.

## What you will not find

**The fleet.** An agent token cannot enumerate other agents, nodes or stations. That is
deliberate and not an oversight: the authority to *do your work* was never the authority to
*find out what else exists*, and an agent enumerating its siblings is an agent doing
reconnaissance.

## It adds no authority

Every tool calls the same service a normal HTTP route calls, through the same checks. There
is no operation available over MCP that is not available over the API, and no second
authorization model.

## Where work lives

AgentPod is the **execution** side: where you run, and what ran there. Claiming a card,
reporting progress and finishing work live in [superpipeline's MCP server](https://docs.superpipeline.dev/build/mcp/),
not this one.

## Inside a station's own session: the node's MCP proxy

An agent running in a station does not need a token of its own to reach these tools. Its node can
run a **loopback MCP proxy** that adds two servers to the harness's `session/new` — this endpoint as
`agentpod` and Superlibrary's as `superlibrary` — reached as the station's own agent through a
`127.0.0.1` URL and a per-station secret that never leave the machine. Only Hermes, Claude Code,
Codex, opencode, Muse and Kilo stations can use it. Salaam uses the managed profile described below.
OpenClaw's and Pi's ACP adapters take no HTTP MCP servers.

```sh
fleet mcp-proxy list                  # which stations each node serves, and any drift
fleet mcp-proxy enable --all-eligible # or name stations; applied without a node restart
fleet mcp-proxy rotate stn_123        # a new secret; a session holding the old one is refused
```

The secrets persist across node restarts, so a session kept open across one keeps its tools. See
[`fleet mcp-proxy`](/reference/fleet/#fleet-mcp-proxy) and
[`apn mcp-proxy`](/reference/apn/#apn-mcp-proxy).

### Salaam's managed profile

Salaam requires an explicitly reviewed AgentPod host manifest with `mcp_config`. The private
profile pins the proxy origin, protocol, catalog, admitted tool schemas and read or approval
policy. An existing host without this profile keeps MCP disabled. Missing assignments, changed
schemas or a mismatched adapter fail readiness before the worker can use the tools.

The node sends the credential directly to the daemon. ACP declarations contain empty headers;
provider payloads receive the progressive `salaam_mcp` interface. To discover a tool, use
`action: "catalog"`, then the server name, then the server and tool name to retrieve its schema.
Use `action: "call"` with that schema to invoke it. For example, `library_search` is reached
through server `superlibrary`, rather than registered as a separate model tool.

The proxy binds its credential to the admitted principal, occupancy and run context. It checks
the forwarded station token's principal and organization, replaces the cache on a binding
handoff, and persists that binding across node restarts. The upstream still verifies the
organization plane's signature, issuer, audience and entitlement. This adds no token issuer or
audience.

Reconnect preserves saved call identities and receipts. Changed bindings invalidate old
credentials and decisions. Mutating tools require an operation-bound approval; a protocol reply
alone does not verify the external effect. An uncertain mutation stays blocked for reconciliation
and is never automatically dispatched again. This profile enables managed HTTP MCP only;
arbitrary client-supplied servers, stdio commands and station coding tools are not enabled by it.

## Next

- [Authentication](/build/auth/) — where the token comes from and how it is verified

### Managed proxy compatibility and responses

A reviewed Salaam assignment uses a versioned route bound to its complete execution
identity. Older transparent proxies reject that route before forwarding. A bound
credential cannot use the legacy route; reconnecting through an incompatible node
requires an upgrade and a fresh readiness check.

The managed route sanitizes exact injected station-token and proxy-key echoes and
common encodings across streamed response chunks. It forwards only MCP response
metadata, suppresses cookies and trailers, and rejects opaque content encodings.
Safe SSE progress continues to stream. Upstream body-copy failures produce fixed
diagnostics. These controls do not replace product authorization or establish
that arbitrary malicious response encodings are safe.
