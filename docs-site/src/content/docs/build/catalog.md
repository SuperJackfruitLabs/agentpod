---
title: Capability catalog
description: A read-only API for services - what exists in a workspace (harnesses, skills, MCP servers, CLIs, brokered services) and what each station has, with how each fact is known.
---

The hub answers two questions for a service that places work, such as SuperDispatch:

- **The catalog: what exists.** Every harness, managed skill profile, MCP server, CLI and brokered
  service that some station in the workspace has.
- **The registry: who has it.** For each station, how strongly it is isolated, the model it last
  ran with, the catalog entries it can use, and the credential names it can reach.

Answers carry names only. A credential is its name, such as `forge:github`, never a token or a key.

## Who may read

A **service** principal listed in the hub's `CATALOG_READERS` setting (comma-separated principal
ids). Unset, no service may read. People and agents are refused. The token is an
organization-plane bearer token, as for every other door (see [Authentication](/build/auth/)).
Every answer is scoped to the caller's workspace.

## The reads

| Request | Answer |
|---|---|
| `GET /api/catalog` | `{ entries: CatalogEntry[] }` |
| `GET /api/catalog/stations` | `{ stations: StationCapabilities[] }` |
| `GET /api/catalog/stations/:id` | one `StationCapabilities`, or 404 |

A catalog entry:

```json
{
  "id": "service:forge-api",
  "kind": "service",
  "name": "forge-api",
  "version": null,
  "source": "supertoolkit",
  "licence": "Apache-2.0",
  "credentials": ["forge:forgejo", "forge:github"]
}
```

- `kind` is `skill`, `mcp`, `cli`, `harness` or `service`. `id` is `<kind>:<name>`.
- `version` is the newest one any station reported, or null.
- `licence` is an SPDX id when known. Null means nobody has checked it yet, not that it has none.
- `credentials` lists the names of the credentials the entry needs.

A station's row:

```json
{
  "stationId": "stn_...",
  "principalId": "prn_...",
  "harness": "salaam",
  "isolation": { "level": "sandbox", "runtime": "runsc", "proof": "installed" },
  "model": { "id": "kimi-k2", "proof": "probed" },
  "tools": [{ "id": "harness:salaam", "proof": "probed" }, { "id": "mcp:superpipeline", "proof": "declared" }],
  "credentials": [{ "name": "forge:github", "instance": "https://github.com", "proof": "probed" }]
}
```

## How a fact is known

Every fact carries a `proof`, strongest first:

| Proof | Means |
|---|---|
| `probed` | Something checked it works: the harness reported it in a real run, or a broker grant was verified |
| `installed` | AgentPod put it there: adopted, provisioned, applied or delivered |
| `declared` | Someone said so, and nothing has checked it |

## Where each fact comes from

| Fact | Source | Proof |
|---|---|---|
| `isolation` | The newest live runtime AgentPod provisioned for the station's node. gVisor (`runsc`, Modal) and microVMs (Fly, Cloudflare) are `sandbox`; another container runtime is `container`; an enrolled machine with none is `host` | `installed`; `host` is `declared` |
| `model` | The newest run fingerprint that names a model | `probed` when the harness reported it, else `declared` |
| `harness:<name>` | The station itself | `probed` once the harness reported a run, else `installed` |
| `skill:<profile>` | The latest applied managed skill install for the profile, and the trusted release it came from | `installed` |
| `mcp:superpipeline` | An enabled roster row with a board-tools token | `declared` |
| `mcp:agentpod-proxy` | The operator's `fleet mcp-proxy enable` | `declared` |
| `cli:stk`, `service:forge-api`, `forge:<provider>` | SuperToolkit's broker on the station, by its forge API grants | `probed` when verified, `installed` when delivered, else `declared` |

All of it is read from the hub's own records. The hub never probes a node to answer, so a read is
fast and the answer can be older than the machine. MCP servers configured inside a harness's own
settings, and the broker's other services, are not listed yet.
