---
title: Reads for services
description: The doors that take an agent's or a service's token rather than a person's - the bridge roster, run evidence and transcripts - with the setting or grant scope each one needs.
---

The operator API takes people only. A handful of reads exist for other products instead: they
take an organization-plane token for an **agent** or a **service**, verify it themselves (see
[Authentication](/build/auth/)), and answer only within the caller's workspace.

| Door | Who may call | Allowed by |
|---|---|---|
| `/mcp` | agents and services | the token alone; each kind is offered its own tools ([MCP tools](/build/mcp/)) |
| `/api/catalog/*` | services | the hub's `CATALOG_READERS` setting ([Capability catalog](/build/catalog/)) |
| `/api/bridge/*` | services | the hub's `ROSTER_READERS` setting (below) |
| `/api/evidence/*` | agents and services | a grant scope on the token (below) |

Nothing here writes, except the one export below.

## The bridge roster

A placement service, such as SuperDispatch, chooses among the agents that claim from a board. A
library service records who owns a station. Both read the bridge's roster:

| Request | Answer |
|---|---|
| `GET /api/bridge/boards/:boardId/roster` | `{ boardId, agents: [...] }`: every roster entry on the board |
| `GET /api/bridge/stations/:id` | `{ id, key, owner }`: whose station it is, or 404 |
| `GET /api/bridge/principals/:prn/boards` | `{ boards: [...] }`: the boards an agent holds an enabled roster entry on |

Each entry in a board's roster:

```json
{
  "key": "writer-1",
  "stationId": "…",
  "principalId": "prn_…",
  "enabled": true,
  "busy": false,
  "lastDispatchedAt": "2026-11-12T09:30:00.000Z",
  "ready": true,
  "reason": null
}
```

- **`ready`** and **`reason`** are the bridge's own readiness answer for the station, the one the
  console shows. A station that does not answer within five seconds is not ready, and a disabled
  entry is never asked.
- **`busy`** is true when the station has a run in hand on any board of the workspace, including a
  run waiting on a person's answer. A **parked** run (a strict Salaam run that can no longer be
  driven, kept for an operator) does not count: the bridge claims new work on that station, so
  calling it busy would be wrong.
- **`principalId`** is null for a station with no agent yet.

**Who may read:** a service principal whose id is in `ROSTER_READERS` (comma-separated). Unset, no
service may read. People and agents get 403. The setting is read on each request, so changing it
needs no restart.

## Run evidence

The reads an evaluation service, such as SuperWitness, makes about the work agents did. Each one
names the single grant scope it needs; holding another scope never stands in for it, and a
person's token is refused whatever it carries.

| Scope | Opens |
|---|---|
| `evidence:read` | runs, attempts, principals and execution exports |
| `transcripts:read` | what a session said: prompts, messages, tool inputs and outputs, redacted |
| `runs:write` | nothing on the hub. SuperWitness honours it, for reporting runs to its registry |

`evidence:read` does not include `transcripts:read`, and the other way round: knowing that a run
failed is not permission to read what it said.

| Request | Scope |
|---|---|
| `GET /api/evidence/runs/:source/:externalRunId` | `evidence:read` |
| `GET /api/evidence/runs/:source/:externalRunId/execution` | `evidence:read` |
| `POST /api/evidence/runs/:source/:externalRunId/execution/export` | `evidence:read`, agents only |
| `GET /api/evidence/exports/:exportId` | `evidence:read` |
| `GET /api/evidence/attempts/:attemptId` | `evidence:read` |
| `GET /api/evidence/principals/:principalId` | `evidence:read` |
| `GET /api/evidence/sessions/:sessionId/transcript` | `transcripts:read` |
| `GET /api/evidence/sessions/:sessionId/transcript/items/:seqFrom` | `transcripts:read` |

A grant's scopes are its `scopes` field, set with `fleet grants set` or, for a new service, with
`fleet principals add-service --scope`. Another workspace's run or session is 404, never
403, so a refusal does not confirm that it exists.

## Next

- [Authentication](/build/auth/): getting and presenting a token
- [Capability catalog](/build/catalog/): what exists in a workspace and which station has it
- [Working a board](/use/boards/): the bridge whose roster this reads
