import { z } from "zod";

/**
 * Identifier grammars — AgentPod's, and the kaambaan ones AgentPod consumes.
 *
 * Before this module there was **no id-shape validator anywhere in AgentPod**:
 * every id field in this package is a bare `z.string()`, every id column is
 * `text().primaryKey()` with no CHECK, and no route validates a path param.
 * Prefixes existed only as minting conventions and schema comments.
 *
 * That is the same hole that let kaambaan declare `mem_` while its API minted
 * `mbr_` for as long as both existed. Nothing validated a minted id against a
 * schema, so nothing could notice.
 *
 * Each schema here is pinned by the shared corpus at
 * `fixtures/ecosystem-identity/id_grammar.json`, which both repos check in and
 * test against. Change a grammar here without changing it there and
 * `tests/ecosystem-identity.test.ts` fails.
 *
 * These are **not** yet applied to the existing contract shapes. Retrofitting
 * `NodeSummary.id` and friends would reject rows already in the database if any
 * predates the current mint sites, so adoption is a separate, evidence-led step.
 * What this module buys today is that the grammars are written down once,
 * executable, and cross-checked against the peer repo.
 */

// ─── kaambaan ────────────────────────────────────────────────────────────────

/**
 * kaambaan's id grammar, mirrored: `<prefix>_<base62, at least 6>`.
 *
 * Deliberately **not** narrowed to the 16 lowercase hex characters
 * `newId()` actually produces (kaambaan apps/api/src/ids.ts). AgentPod does not
 * mint these and must not be stricter than the minter's own declared contract —
 * kaambaan's test suite asserts `run_Aa0Bb1` parses, so a hub that rejected it
 * would make the seam unusable in one direction over a shape kaambaan considers
 * legal.
 *
 * Source: kaambaan packages/contract/src/ids.ts:7-10.
 */
const kaambaanId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,}$`), `expected a "${prefix}_…" id`);

export const KaambaanTenantId = kaambaanId("tnt");
export const KaambaanUserId = kaambaanId("usr");
/** `mbr`, not `mem` — the drift this corpus exists to make impossible. */
export const KaambaanMembershipId = kaambaanId("mbr");
export const KaambaanAgentId = kaambaanId("agt");
/**
 * The run join key, and `run_` belongs to it alone.
 *
 * kaambaan mints the work run; AgentPod executes it and never mints a rival id
 * for the same attempt (see `Run.externalRunId` in ./run.ts). AgentPod used to
 * reserve this same prefix for `acp_runs.id`, which made the two id spaces
 * indistinguishable strings; AgentPod's own key is now `AcpRunId` below, and
 * the corpus asserts that neither grammar accepts the other's ids.
 */
export const KaambaanRunId = kaambaanId("run");

// ─── AgentPod ────────────────────────────────────────────────────────────────

/**
 * AgentPod mints two incompatible id shapes and has never written either down.
 *
 * `<prefix>_<20 lowercase hex>` — a UUID with its hyphens stripped, truncated to
 * 20 — comes from a helper duplicated verbatim in two services
 * (apps/hub/src/services/enrollment.ts:11-12 and .../runtimes.ts:54-55).
 *
 * Note the length disagreement with kaambaan, which slices the same source to 16.
 * Neither repo records a reason. Pinning both here is what makes the difference
 * visible rather than incidental.
 */
const truncatedUuidId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{20}$`), `expected a "${prefix}_…" id`);

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * `<prefix>_<hyphenated UUID>` — the second family, inlined at each mint site
 * rather than shared (station-registry.ts:50, acp-sessions.ts:641, audit.ts:94).
 *
 * The hyphen matters across the seam: kaambaan's declared alphabet is base62
 * with no separator, so kaambaan's own contract would reject every AgentPod
 * station id it was ever handed. That is a live disagreement, recorded in the
 * corpus under `openDisagreements`.
 *
 * The UUID version nibble is deliberately not pinned. Every mint site uses
 * `crypto.randomUUID()` (v4) today, but pinning it would turn a future move to
 * v7 into a false failure about a shape that is still perfectly well-formed.
 */
const uuidSuffixedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_${UUID}$`), `expected a "${prefix}_…" id`);

export const NodeId = truncatedUuidId("node");
export const RuntimeId = truncatedUuidId("rt");
/**
 * The enrollment-token **row** id. The token itself is a different thing with a
 * different shape — `enr_` + 20 hex + 32 hex (enrollment.ts:53-54) — and is a
 * secret. Kept apart so no validator can blur an identifier into a credential.
 */
export const EnrollmentTokenId = truncatedUuidId("etk");

export const StationId = uuidSuffixedId("station");
export const AcpSessionId = uuidSuffixedId("acps");
export const AuditEntryId = uuidSuffixedId("audit");

/**
 * `acp_runs.id` — one **attempt** on a station, and deliberately not `run_`.
 *
 * The prefix was `run_`, colliding head-on with the id kaambaan mints for a work
 * run: the schema file declared `"run_" + uuid-ish` six lines above the comment
 * "We never mint a rival id", and a `run_…` in an AgentPod row could not be told
 * from a kaambaan one without reading a second column. AgentPod moved rather
 * than kaambaan because AgentPod is the executor: kaambaan mints these ids and
 * has live production data, while nothing here has ever inserted an `acp_runs`
 * row at any commit, so the rename cost nothing — and would stop being free the
 * moment the bridge writes its first run.
 *
 * `attempt` is not a euphemism for `run`. A run here is a **prompt-turn** — it
 * opens when a prompt is submitted and closes when the agent yields — while
 * kaambaan's work run is a claimed card, which takes as many prompt-turns as the
 * work takes. One work run is therefore executed as a series of attempts, and
 * the counts never matched: the two were never the same entity, whatever the
 * shared prefix implied.
 *
 * Hyphenated-UUID family, matching its sibling `acps_` in the same subsystem
 * (`acp_runs.session_id` is a FK to `acp_sessions.id`). `acpr_` was considered
 * and rejected: one character from `acps_`, and the live `acp_`/`acps_` near-miss
 * between the node-agent and the hub is already trap enough.
 *
 * Unlike the grammars above, this one **is** applied — to `Run.id` in ./run.ts.
 * The retrofit caveat in this module's header is about rejecting rows that
 * already exist; there are none, which is exactly what makes adoption safe here
 * and not yet safe for `NodeSummary.id` and friends.
 */
export const AcpRunId = uuidSuffixedId("attempt");

/**
 * AgentPod's principal id: a bare UUID with no prefix at all.
 *
 * Better Auth's `advanced.generateId` is overridden to `crypto.randomUUID()`
 * (apps/hub/src/auth/drizzle-auth.ts:249), which applies to user, session,
 * account and verification alike; admin-created users call `crypto.randomUUID()`
 * directly (apps/hub/src/routes/admin.ts:432) — the same grammar by coincidence,
 * not by shared code.
 *
 * kaambaan's principal is `usr_<16 hex>`. The two cannot be exchanged and no
 * mapping exists in either repo. Per ecosystem decision 2, that mapping must be
 * minted by an explicit link when it arrives — never inferred from a matching
 * email or a lookalike localpart.
 */
export const UserId = z.string().regex(new RegExp(`^${UUID}$`), "expected a bare UUID user id");
