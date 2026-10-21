# Salaam execution evidence v1

**Description, 2026-10-21; local implementation, not a deployment claim.**

Authority is the accepted Charter decision `2026-10-04-superwitness-owns-observability-and-evaluation`
and the user's M23 implementation request. The September evidence-join draft remains proposed.
No principal grant, token audience, lease, retention rule, or legacy C5 schema changes here.

The canonical closed contracts and success/rejection corpus are
`packages/contract/src/execution-evidence.ts` and its `fixtures/execution-*-v1*` files.
The generated JSON Schema is checked against Zod by `execution-evidence.test.ts`.
Salaam owns the historical task/session/attempt/child/check/tool/artifact/readiness receipts;
AgentPod owns the persisted original work admission and Library export receipt; Witness owns
joining and evaluation. Salaam UUIDs and Hub `attempt_` IDs remain separate namespaces.

## Opt-in reads

`GET /api/evidence/runs/:source/:run/execution?schema_version=salaam-execution-evidence%2Fv1`
requires the existing `evidence:read` permission. It returns the closed
`agentpod-execution-evidence/v1` wrapper. A known run without Salaam work has an empty
`executions` array. A missing/foreign-tenant run is 404, unknown/omitted versions are 400,
and an unavailable or inconsistent original source is 502. Legacy C5 stays unchanged.

`execution.ts` compares the source response with the durable original admission, exact
run source/id/epoch, organization/principal/station/occupancy/Hub session, work request,
task/session receipt, board/card/stage and input/plan digests. Workspace travels only on
the private authenticated control path; it is omitted from exported metadata. Historical
reads do not validate or renew a current execution lease. Source fingerprints describe
historical pinned readiness, with a checked content digest; they do not assert freshness.

## Explicit immutable export

`POST /api/evidence/runs/:source/:run/execution/export` accepts only
`{schema_version:"salaam-execution-evidence/v1",request_id:<UUID>,artifact_ids?:<UUID[]>}`.
It requires the existing evidence permission and the exact original agent principal.
It never accepts caller-supplied artifact bytes. No artifact selection exports only metadata.
A selection of 1–16 IDs fetches the private versioned source bundle, independently validates
each original evidence reference/session/disposition, decoded byte length and SHA-256,
and rejects observed artifacts, non-UTF8 content, duplicate or substituted IDs and totals over 4 MiB.
Source-side admission also rejects baseline/prompt/configuration artifacts.

`execution-export.ts` freezes canonical bytes before Library declaration. The Postgres
`execution_exports` ledger retains original principal/tenant/work metadata, optional actual
artifact bundle, SHA-256, upload ID, status and final receipt. Metadata-only export uploads `execution-evidence.json`. Selected artifacts upload a metadata
`execution-manifest.json` and separate raw `artifacts/<UUID>.json` files through the existing
Library multi-file API, so its scanner receives the actual source bytes. The internal frozen
base64 transport is never substituted for raw-file scanning. Raw total is capped at 4 MiB
and the combined manifest plus raw files at 8 MiB (at most 17 files; Library allows 500). Only the explicitly versioned node evidence responses gain an 8 MiB bounded read;
legacy authority/control responses retain 1 MiB. Existing gateway frame limits are unchanged.

PUT and uncertain commit retries use the saved upload ID and bytes. A crash after declaration
starts but before its response is persisted remains `declaring`, deliberately ambiguous;
the existing Library API has no client-assigned declaration key. It cannot automatically
allocate a replacement upload. Source integrity failure precedes remote effects. A Library
commit is insufficient: returned bundle SHA/byte length and every actual signed file download must match.
Only then is the export committed. Library integrity failure stays explicit.

`GET /api/evidence/exports/:exportId?schema_version=agentpod-execution-export%2Fv1`
returns tenant-scoped committed proof under the existing evidence scope. Unconfirmed records
are 409. The proof identifies both representations: `manifest_sha256` and `manifest_bytes` describe
the actual metadata file. `library.sha256` and `library.bytes` describe the complete Library
bundle (the SHA-256 of sorted `[path,fileSHA]` pairs for multi-file exports). `artifact_files`
contains each original artifact digest/bytes/disposition and the actual Library immutable
composite file identity `{item_id,version,path}`. A metadata-only proof has no artifact files. A proposed patch
or observed check is never promoted to integration by export.

## Independent outcomes

After verified Library completion, an enabled existing M21 bridge can attach an ordinary
Pipeline reference with the original configured principal and exact run/card/stage/epoch.
No replacement occupant or legacy credential is a fallback. Pipeline marks the hint
`unverified`; Witness verifies the separate AgentPod proof with its existing evidence token.
Stale run, missing configuration or reference failure leaves the artifact committed and
reports `reference_status:unavailable`.

Optional work-trace correlation uses only active W3C context. The private versioned trace
call carries no new authority; source preserves the first root trace on retries. No context
is a no-op, failure is recorded independently as telemetry unavailable, and neither case
blocks progression or changes a grant. `trace_context_status:recorded` means correlation was recorded. Its separate
`telemetry_status:delivery_unconfirmed` explicitly states that no collector delivery receipt
exists. Unavailable/unreported correlation maps to unavailable/unreported telemetry; no
export response claims telemetry was delivered. Usage remains ledger-recorded, never provider-billing proof. Toolkit operator attestations
retain native `outcome_unknown`; their explicit `product_effect_verified:false` and
`authority:false` cannot be promoted to provider or product effect proof.

## Executed checks and limits

The tests cover strict corpus/schema parity, old C5 behavior, original-root historical reads,
foreign epoch/task/tenant rejection, actual source byte selection and corruption, independent
fingerprint digests, persisted Postgres upload identity/restart recovery, uncertain declaration,
commit replay, returned Library bytes, optional trace failure, original-principal references,
and the narrow node response cap. Integration uses an owned disposable pgvector Postgres on
loopback 5434 with explicit `DATABASE_URL`; no production effects are part of these tests.
Live cross-product C10 acceptance and deployment remain separate evidence.
