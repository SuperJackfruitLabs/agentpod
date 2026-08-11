# AgentPod — The Suite: Five Planes, One Join Key

> **Date:** 2026-08-10 · **Amended:** 2026-08-11 · **Status:** Strategy — for discussion
> **Scope:** product direction for AgentPod and the surrounding agentic suite
> **Supersedes:** nothing. Complements the founding [fleet-console design](../superpowers/specs/2026-06-21-agentpod-fleet-console-design.md) (2026-06-21) and revisits its work/runtime split.
>
> **2026-08-11 amendment.** Two changes, both from checking claims against code rather than
> memory. (1) Delivery is forge-neutral and `change` is a first-class entity — §7. (2) The
> work plane is **kaambaan**, a separate repo, and it is far more built than the original
> draft assumed — the board, the A2A state machine, gates, attempts comparison and metering
> already ship there. §7 is rewritten around that boundary, §4/§5/§8/§9/§10 follow it, and
> Horizon 2 shrinks accordingly.

The suite is the right ambition, and the architecture already supports it better than
it gets credit for — the provisioner drivers *already* make every sandbox self-enroll
as an ordinary station, which is the exact primitive that lets one system span Docker,
Kubernetes, E2B and someone's laptop. But a suite only beats a collection of tools if
the pieces share something other than a logo.

**The thing that has to be shared is not the contract package. It's a single run
identity that threads work → agent → runtime → conversation → cost → audit.** Build
that first and each new plane gets cheaper. Build it last and it gets retrofitted at
ten times the price.

---

## 1. What we already have

The asset inventory, ordered by how expensive it would be for someone else to replicate:

- **A Go binary that lives on other people's machines and dials out.** No inbound ports,
  NAT/CGNAT-friendly, self-updating against signed checksums, with `apn` service
  management on systemd and launchd. This is the hard part. Everything else is
  software; this is distribution.
- **A provisioning layer whose drivers hand off to that binary.** `ProvisionSpec`
  injects a hub URL and a one-time enrollment token; the container boots, enrolls
  itself, and becomes a station. Docker and Cloudflare implement it today. *This is the
  single most under-exploited thing in the repo* — see §5.
- **A harness-agnostic descriptor layer** across Hermes, OpenClaw, Claude Code, Codex and
  OpenCode, normalizing filesystem, logs, terminal, health, lifecycle, cleanup and config.
- **A hub-terminated ACP client** with append-only replayable transcripts, permission
  modes, and audited decisions. Sessions outlive the browser tab.
- **One zod contract** shared node ↔ hub ↔ console — 15 verbs already shaped like tool
  schemas.

> **The structural insight.** The provisioner interface ends its job the moment the
> node-agent inside the sandbox enrolls. After that, an E2B microVM, a Kubernetes pod,
> and a MacBook are *the same object* to every capability we've built. That invariant is
> what makes a suite tractable for a small team: N substrates cost N thin drivers, not
> N products.

---

## 2. The board (August 2026)

Most layers now have an owner. The suite question is which we join, which we multiplex,
and which we route around.

| Layer | Who owns it | Our move |
|---|---|---|
| Agent ↔ client protocol | ACP — Zed + JetBrains, Apache-licensed, 25+ agents, public registry, adopted by Google and GitHub | **Join** — already did |
| Ephemeral sandboxes | E2B, Daytona, Blaxel, Modal, Runloop — seven providers bundled in the OpenAI Agents SDK | **Multiplex**, don't compete |
| Sandbox standard | kubernetes-sigs `agent-sandbox` — Sandbox / SandboxTemplate / SandboxClaim / SandboxWarmPool CRDs, pause-resume, warm pools | **Implement as a driver** |
| Cloud task assignment | GitHub Agent HQ / mission control, free with Copilot; agents from Anthropic, OpenAI, Google, Cognition, xAI | **Route around** — see §7 |
| Local parallelism | Conductor, Vibe Kanban, Gastown, Claude Squad | Absorb the use case |
| Enterprise agent posture | Zenity, Varonis Atlas, Prisma AIRS — all aimed at SaaS agents inside the enterprise | Aimed elsewhere |
| **Runtimes people own** | **Nobody** | **Ours already** |

### Why the last row still anchors everything

| Signal | Value |
|---|---|
| OpenClaw GitHub stars (self-hosted-first runtime) | 369K |
| Hermes stars by mid-2026 | 200K |
| OpenClaw instances found exposed to the internet (Shodan, Feb 2026) | 42,000+ |
| …of those, running with gateway auth disabled | 63% |
| CVEs across OpenClaw and predecessors, Feb–Apr 2026 | 138 |
| Malicious skills pushed to ClawHub in the ClawHavoc campaign | 1,200+ |

Both runtimes already have descriptors in this repo. The suite doesn't replace this
position — it's the plane the other four hang off, and the reason our work plane can
dispatch to machines GitHub cannot see.

---

## 3. Thesis: the join is the product

Every competitor owns one plane and is blind to the others. Agent HQ knows what work was
assigned but nothing about the machine. E2B knows the sandbox but nothing about the task.
Zed knows the conversation but neither. Langfuse knows the tokens but not the runtime.

A suite that merely bundles those planes is worth the sum of its parts, which is less
than any one specialist. A suite that *joins* them answers a question nobody else can:

> **Which agent, doing what work, on which runtime, under what permissions, producing
> which diff, at what cost — and here is the transcript.**

That sentence is the product. It is also, concretely, a database design decision: a
**`run`** entity that every plane writes against.

- **Work plane** creates the run from a task.
- **Substrate plane** attaches the station it was placed on.
- **Conversation plane** attaches the ACP session and transcript.
- **Governance plane** attaches the policy evaluated, permissions answered, tokens spent,
  and posture of the host at the time.

Four of those five things exist in production already, keyed by four different ids. The
work is not building new capability — it's giving what exists a shared spine.

> **Sequencing consequence.** The run identity belongs in Horizon 0, before any new
> plane. Every week we ship a plane without it, we add another id to reconcile later.
> Retrofitting a join key across five products is the classic way a suite becomes a
> collection.

---

## 4. The five planes

Products can ship separately, be branded separately, even live in separate repos
eventually. Architecturally there are five planes and one spine.

| # | Plane | Status | What it is |
|---|---|---|---|
| 1 | **Runtime** — where agents live | Built | node-agent, hub gateway, station registry, descriptors, capabilities. Attach-first for machines we own. Everything else resolves down to "a station with capabilities." |
| 2 | **Substrate** — where runtimes come from | 2 of ~8 drivers | Provisioning across Docker, Kubernetes, and hosted sandbox providers. The differentiator is not creating sandboxes — it's that a sandbox we created and a laptop we attached are indistinguishable downstream. (§5) |
| 3 | **Conversation** — how you talk to them | Built + Doors | Hub-terminated ACP, persisted transcripts, permission modes. Remaining move is inversion: also be an ACP *server*. (§6) |
| 4 | **Work** — what they should do | **Built — in kaambaan, a separate repo** | Boards, cards, tasks, runs, stages, gates, review. *Not ours to build.* kaambaan already ships the A2A state machine, the agent contract over REST and MCP, gates, attempts comparison and per-attempt metering. Our job is to be its fleet. (§7) |
| 5 | **Governance** — trust, policy, spend | Ledger exists | Not a product — a layer every plane reports into. Posture and patching, fleet policy, cost accounting, audit. (§8) |

> **Design rule to hold across all five.** A plane may only talk to another plane through
> the contract, never through its database. The moment the work plane reads `stations`
> directly, we have a monolith with extra repos — the worst of both structures.

---

## 5. The spine: contracts, and the repo question

The instinct toward separate projects sharing contracts is right, but the ordering
matters: **publish the contracts first, split the repos later — and only when a product
earns its own release cadence.** A solo maintainer with four repos, four CI configs and
cross-repo PRs ships less than one with a monorepo, and the contract packages give us the
option to split at any time for free.

### Split the contract into versioned packages

`packages/contract` is 664 lines exporting everything from one barrel. For five planes
that becomes a coupling hazard — a work-plane change forcing a node-agent release. Split
along plane boundaries, version independently, publish to npm:

| Package | Owns | Consumed by |
|---|---|---|
| `contract-runtime` | gateway frames, station, capabilities, the 15 verbs | node-agent, hub, console |
| `contract-substrate` | provision spec, driver capability manifest, lifecycle | hub, drivers |
| `contract-session` | ACP session, events, permission protocol | hub, console, external clients |
| `contract-change` | change, changeset, delivery adapter | hub, console — projected into kaambaan as a `reference` |
| `contract-identity` | org, actor, agent identity, policy, budget | everything |

> **There is no `contract-work` package, and there should not be.** kaambaan owns
> initiative/card/task/run/stage/gate/verdict and has already shipped them. We consume that
> contract **over the wire, not by import** — its package is `private: true`, designed to be
> projected onto REST and MCP surfaces, and it is on zod 4 while we are on zod 3.25. Importing
> it would drag a zod major into the hub, contract and console for no benefit. Speak the
> surface; validate against our own schemas. (§7)

### Generate the Go side

Today the node-agent hand-writes Go structs mirroring the zod schemas. With one product
and one author that's a manageable discipline. With five planes and outside contributors
it's a correctness bug waiting to happen — and it's the crack that widens fastest as the
suite grows. Generate **zod → JSON Schema → Go types**, checked into CI so a contract
change that skips regeneration fails the build. Do this in Horizon 0; it gets more
expensive every month.

### Naming

If the planes ship as separate products, the umbrella needs to mean the join, not the
runtime. "AgentPod" currently names plane 1. Either promote it to the suite name and
rename the runtime plane, or pick a suite name and let AgentPod stay the runtime product.
Deciding this late is how we end up with a product called AgentPod inside a product
called AgentPod.

---

## 6. Substrate: we're the multiplexer

An earlier draft of this analysis argued provisioning was commoditized and should be
frozen. That was right about *raw sandboxes* and wrong about our position. When OpenAI
bundles seven sandbox providers into its SDK, that is the market declaring it wants
portability — and portability layers are won by whoever also does management. E2B will
never manage your laptop. We already manage both.

### What has to change in the code

- `RuntimeProviderName` is a closed union of `"docker" | "cloudflare"`, and
  `isProviderEnabled` is a hardcoded switch over env flags. Open both: registry-driven
  names, drivers declaring a capability manifest (pause, snapshot, persistent disk,
  regions, billing model).
- Credentials move from env flags to per-org encrypted storage. Eight providers × N
  tenants does not fit in `ENABLE_X_PROVISIONING=true`.
- Add optional `pause` / `resume` / `snapshot` / `restore` to the driver interface.
  Pause-resume is the cost lever for always-on agents, and both `agent-sandbox` and the
  faster hosted providers expose it.
- A **driver conformance suite** — one test file every driver must pass — run nightly
  against real accounts. With eight providers, provider API drift becomes our top source
  of breakage.

### Which drivers, in what order

| Driver | Model | Why it earns a slot | Order |
|---|---|---|---|
| `docker` | Local containers | Reference driver, self-host, demos | Have |
| `cloudflare` | Edge sandboxes | Already wired, incl. webhook | Have |
| `generic ssh` | BYO host | Nearly free — cloud-init plus the `install.sh` and `SHA256SUMS` we already publish and already verify. Covers every provider we never write a driver for, and it is the shape the fleet already takes. | **First** |
| `e2b` | Firecracker microVM | Strongest isolation story and the most mindshare; the provider people name when they say "sandbox" | **First** |
| `fly machines` | Per-machine VMs | Cheap always-on; the natural home for a personal Hermes or OpenClaw | **First** |
| `k8s agent-sandbox` | Sandbox CRD | The emerging standard, SIG-backed, pause-resume and warm pools built in, ships Hermes and OpenClaw examples, and it is our entry into every company already running Kubernetes — but it needs a cluster to test against, and §6's own rule says a driver we cannot test is a driver we do not ship. Enterprise-signalling ahead of demand. | Second |
| `modal` · `runloop` · `blaxel` | Hosted sandboxes | Parity with the OpenAI SDK's bundled set; Blaxel resumes paused environments in tens of milliseconds | Third |
| `daytona` | Persistent workspaces | Closest model to always-on agents, sub-90ms create — but its production codebase went closed-source in June 2026, so hosted-only, no self-host story | Third |

> **Why SSH leads.** The first wave is chosen for testability and for the fleet we actually
> have, not for the logo on the slide. `generic ssh` is verifiable against any VPS — or a
> local container — on day one, which is the only wave-one property that matters given the
> invariant below.

> **Hold this invariant.** Every driver's responsibility ends at enrollment. No
> driver-specific paths downstream, no capability that only works on Docker. The day one
> plane needs to know which substrate it's on is the day the suite starts costing N×
> instead of N.
>
> The mirror of this rule on the outbound side — no forge in the work plane's model — is
> in §7. Same failure at the opposite end of the pipe: inbound we refuse to let one
> sandbox provider become the model; outbound we refuse to let one forge become it.

---

## 7. Work: kaambaan is the work plane; we are its fleet

GitHub gives away task assignment with Copilot, across web, VS Code, mobile and CLI. We
do not win that by building a better kanban. We win by dispatching where they
structurally cannot: **heterogeneous harnesses, heterogeneous substrates, and private
hosts.** Agent HQ assigns cloud agents into GitHub's own sandboxes. We can assign a task
to Claude Code on a colleague's workstation, Hermes on a Hetzner box, and Codex in an E2B
microVM — and compare the three.

The corollary is that we must not hand the last mile back. A dispatch layer whose every
output has to become a GitHub pull request has routed around Agent HQ and then delivered
its work to GitHub anyway.

### This plane already exists, and it is not in this repo

kaambaan is the work plane — a separate product and repo, `rakeshgangwar/kaambaan`. An
earlier draft of this document treated it as greenfield ("New"). It is not. Verified against
the code on 2026-08-11:

| What kaambaan already has | Where |
|---|---|
| A2A-exact task state machine — `submitted · working · input-required · auth-required · completed · rejected · failed · canceled`, spelled to match A2A | `packages/contract/src/{primitives,state-machine}.ts`, with a transition-table test suite |
| Agent contract over REST at `/v1/*`, plus programmatic agent registration minting `kbn_` bearer tokens | `apps/api`, `agents-rest.test.ts` |
| MCP server — Streamable HTTP, OAuth 2.1, eleven tools | `apps/api/src/mcp/` |
| An executable **conformance kit** driving a reference agent through a two-stage pipeline over the public REST contract only | `apps/api/test/conformance.test.ts` |
| Gates, attempts comparison, per-attempt cost metering, GitHub references/webhooks, push, triggers | `board-{gates,attempts,metering,references,push,triggers}.test.ts` |
| A Claude Code adapter normalizing `claude -p --output-format stream-json` into the activity envelope | `apps/api/src/adapters/claude-code.ts` |

Two consequences the earlier draft got wrong. **Attempts comparison and cost metering are
already built** — §7's "compare three runs" and §8's "cost per task, per agent, per machine"
are not ours to invent, they are ours to feed. And kaambaan's adapter carries the comment
*"a bridge (reference worker / harness adapter) calls this per line and POSTs each result as
an activity"* — **that bridge is what AgentPod is.** The architecture already has a hole
shaped like us.

> **Note on kaambaan's own docs.** Its README and roadmap claim "P0 — Foundations." The code
> is through roughly P5/P6. Read the tests, not the phase labels.

### The model — where each object lives

Kanban is a view. The model underneath is a run graph, and it now spans two repos:

- **Initiative / Card / Task / Stage / Gate** — *kaambaan.* The unit of intent down to the
  assignable unit with an acceptance condition. Syncable with a GitHub issue or Linear
  ticket; never ask anyone to migrate a backlog.
- **Run** — *kaambaan mints it, we execute it.* One attempt, binding *task + harness +
  station + session + budget + policy*, producing *transcript + diff + cost + verdict*.
  This is the join key from §3, and it already exists as `runId` in kaambaan's activity
  envelope. We do **not** mint a competing id: a station attempt carries kaambaan's `runId`
  when it came from a claim, and a local id when it did not — because the console must keep
  working with no board attached at all.
- **Change** — *ours.* The thing that lands. One change accumulates many runs — a first
  attempt, a revision after review, a CI fix — and resolves to a commit against a base. Runs
  are immutable attempts; a change is the mutable object a human tracks across them. It is
  produced on a station, so it is produced here, and projected into kaambaan as a
  `reference`.

> **Why `change` is not a sixth plane.** The diff is already in the §3 sentence and already
> a run output — this is an under-specified part of the existing thesis, not a plane the
> strategy forgot. It earns a second entity because its lifecycle outlives the run that
> produced it, and it earns nothing more. §10's rule holds: a new plane ships thin or not
> at all.

### The seam: REST for machines, MCP for models

MCP and REST are not two syntaxes for one contract. They have **different callers.** REST is
for when *software* decides — deterministic control flow, lease epochs, idempotency keys,
retries. MCP is for when *the model* decides — tool annotations, elicitation, `isError` so it
can self-correct.

Our hub is software. It claims a card because a scheduler decided to, not because a model
reasoned about it. So:

- **AgentPod ↔ kaambaan is REST.** It is also what the conformance kit exercises, so the
  validation instrument works out of the box, and `POST /v1/agents` already mints a bearer
  that authorizes a claim with no OAuth dance.
- **MCP stays, for the other caller** — a harness working a board directly with no fleet
  involved. That is kaambaan's demo milestone and its distribution channel to people who
  never install us. Two surfaces, two audiences, no redundancy.

> **One refinement to kaambaan's "MCP ≡ REST parity" goal.** Chase *semantic* parity on shared
> verbs, not identical verb sets. `kaambaan_heartbeat` is currently exposed as an MCP tool,
> which hands a model a `leaseEpoch` — machinery it should never touch, and an invitation to
> corrupt lease state. One contract, two projections, MCP a deliberate subset.

### A2A: one agent per station

The topology question is whether the hub registers as *one* agent or *many*. One agent is
simpler and wrong: kaambaan then sees a single opaque blob called "AgentPod," capability
routing degrades to "it can do everything," and attempts-comparison across machines is
invisible to the board. So: **one kaambaan agent per station**, minted by the hub as stations
enroll and retired on cleanup. Registration is already programmatic, so this needs nothing
new from kaambaan.

That gives the sentence the whole integration hangs off:

> **An A2A AgentCard is the projection of a station descriptor.**

The descriptor layer already computes harness type, detected tooling, health and
capabilities. That is most of an AgentCard, and §1's structural insight — everything resolves
to "a station with capabilities" — is exactly what A2A wants to consume. *(kaambaan's doc 04
promises an AgentCard at `/.well-known/agent-card.json`; only the OAuth protected-resource
document is implemented today. The endpoint is unbuilt on both sides.)*

Three mappings then come for free, and each replaces something we would otherwise design:

| Fleet condition | A2A / kaambaan state | What we avoid building |
|---|---|---|
| ACP permission request | `request_input` → `input-required` | A second approval queue — it is the same queue as the gate |
| Station drops, CGNAT disconnect | `heartbeat_timeout` → `submitted` | Fleet failure handling; the card simply becomes reclaimable |
| Harness credential expired on a remote box | `auth_required` → `auth-required`, then `account_linked` | A re-auth model we have no concept of today |

Two rules follow, and both are the §6 invariant in a new costume:

> **Coordination stays board-mediated.** No direct station-to-station A2A messaging. Every
> handoff goes through a card, so every handoff lands in the ledger. Direct agent-to-agent
> chatter is work that never touches the flight recorder — which is the §11 bet and the §8
> monetization. Refuse any path where work escapes the record.

> **Orchestrator-neutrality, exactly as §7 refuses forge lock-in.** Serve an AgentCard per
> station so *any* A2A orchestrator can consume the fleet. kaambaan is the best-supported
> consumer, never the required one. The day a station is only reachable through one board is
> the day we have rebuilt the thing we refused in delivery.

### What this asks of kaambaan

Three fleet-scale problems it has not had to face, all small:

1. **Lifecycle at churn** — stations come and go; needs deregistration/expiry and probably
   agent *groups*, so a board routes to "the fleet" without enumerating fifty agents.
2. **Refreshable capabilities** — tags are fixed at registration, but a station gains Rust
   the day someone installs a toolchain.
3. **A fleet-level concurrency cap** — limits are per-agent today, so fifty station-agents
   can saturate a board.

### Delivery: the terminal state is a git ref

A change resolves to a commit against a base, content-addressed in our own store. Where it
goes next is a **delivery adapter**, and none of them are privileged:

| Adapter | Lands as | Notes |
|---|---|---|
| `git-remote` | A branch pushed to any remote | Zero vendor — Forgejo, Gitea, self-hosted GitLab, or a bare ssh remote. **The default, and it must remain sufficient on its own.** |
| `github` · `gitlab` · `forgejo` | Pull or merge request | For teams that already live there. A convenience, never a dependency. |
| `patch` | `format-patch` series | Mailing-list and air-gapped workflows; also the honest fallback for any forge whose API we don't want to carry. |

Git is not the lock-in — GitHub is. Git is a format with no vendor, and depending on it
buys interoperability with every forge and every developer's existing hands. What we refuse
in the model is the *platform*.

**And don't write a VCS.** If we want better ergonomics for many concurrent working states
on a station, adopt `jj` — git-backed, anonymous branches, op-log undo, automatic
working-copy snapshots — rather than build one. Every serious attempt in this space that
got traction won by being git-compatible, and §10 already names surface area as the top
risk.

Two things this buys beyond avoiding a vendor:

- **The §3 join stays whole.** If you have to call a forge's API to learn which diff a run
  produced, a third party is sitting in the middle of the join key. Content-address the
  change ourselves and the answer is local.
- **It is what makes the §11 flight recorder credible.** "Produce March's agent activity"
  cannot mean "assuming GitHub still has those pull requests and you still have that org."
  A legal record built on another company's retention policy is not a record.

> **Same invariant as §6, opposite end of the pipe.** A delivery adapter's responsibility
> *begins* at a finished change; nothing upstream knows which forge it is headed to. The
> day `contract-change` grows a required `pull_request_id` is the day we have swapped one
> vendor's lock-in for another's and lost the reason we routed around Agent HQ at all.

> **The wedge.** The forge owns everything after the merge request. Nobody owns what comes
> before it — twelve candidate diffs from four harnesses on three substrates, and no way to
> compare them. That gap is the visible payoff of the dispatch argument above, and it is a
> comparison view over an artifact store, not a version control system.

### Three things we get almost free

- **Gates are already built — on both sides.** A stage gate needing human approval is exactly
  an ACP permission request, and kaambaan's `input-required` is exactly where an ACP
  permission lands. Same queue, same audit, same modes, and now the same state name. The
  approval UI is a re-skin of the permission UI, not a new subsystem.
- **The shape is already in the schema.** The vestigial `agent_tasks` table from the
  OpenCode era is literally *task → sandbox → session → response → error*. Don't
  resurrect the table — it's Cloudflare-specific and pre-fleet — but it's evidence we
  found this model once already.
- **The diff already has a path off the box.** Stations expose filesystem and terminal
  today, so packaging a workspace change against a base is a capability, not an
  architecture. It also removes an ugly requirement: no station needs push credentials of
  its own for work done on it to become reviewable.

> **The honest risk on this plane has moved.** It is no longer "we might build a bad kanban" —
> we are not building one. It is **drift between two repos owned by the same person.** The
> conformance kit is the mitigation and it already exists: our bridge either passes it or it
> does not, and that check belongs in CI on both sides. The second risk is duplication by
> accident — the day AgentPod grows its own board, or kaambaan grows its own fleet
> management, one of them is wasted work.

> **What is still unproven, precisely.** Every kaambaan test drives a synthetic in-process
> agent through `cloudflare:test`. Nothing has driven a *real* harness, on a *real* machine,
> through that loop. The conformance kit proves the contract is self-consistent; it does not
> prove the contract survives a persistent ACP session that blocks mid-flight on a permission
> request, or a station behind CGNAT that drops halfway through a claim. That is exactly the
> gap the Horizon 0 spike closes.

---

## 8. Governance: the layer that monetizes the whole suite

The security case doesn't compete with the suite — it's the suite's governance plane, and
it gets stronger as more planes report into it.

### Posture and patch

Descriptors already know where each harness keeps config, credentials, workspace and logs
— most of a scanner. Add `Posture() []Finding`: listeners bound to `0.0.0.0`, auth
disabled, versions behind a CVE, credentials in world-readable files, unvetted skills and
MCP servers, disk pressure. Then remediate through rails we already ship — self-update,
config write with backup, lifecycle.

Ship **`apn scan`** as a free, hubless, single-binary check: no signup, no server, graded
report. It is the top-of-funnel for every plane, it costs a fortnight, and it does not
depend on any other Horizon. Given 42,000 exposed instances and 138 CVEs, it also arrives
into a market actively looking for it.

### Policy and spend

Session permission modes become org-scoped policy — no `full-auto` on production-tagged
nodes, exec requires approval on credential-holding stations. And `acp_events` is already
an append-only ledger; ACP adapters emit token usage (the Codex adapter advertises it
explicitly). Add a usage event type and, keyed by run, we get cost per task, per agent,
per machine, per person. **Nobody else can compute that for self-hosted agents, because
nobody else is on the box.**

> **When the board and the runtime disagree, the runtime wins.** A card can dispatch work that
> fleet policy forbids — `full-auto` on a production-tagged node, exec on a credential-holding
> station. The runtime refuses, because it is on the box and it is the last line, and it
> **reports the refusal back as an activity** so it lands in both records rather than looking
> like a silent failure. This is the policy analogue of `acp_events` being authoritative:
> whoever holds the ground truth holds the veto.

> **Division of labour with kaambaan, so this is not metered twice.** kaambaan already meters
> per tenant·board·card·attempt·agent·model — but only for work it dispatched. `acp_events`
> stays **authoritative**: it is on the box, it is sequenced, it holds permission decisions
> kaambaan never sees, and it covers sessions that never came from a board at all. kaambaan's
> activity envelope and any A2A message stream are **projections** of it. One writer, many
> readers — otherwise the two ledgers drift and neither can be trusted for §11.

### Approvals that reach a human

The permission queue exists; the missing hop is the notification. A PWA plus push turns
"blocked, waiting for you" from a forgotten tab into something answered from a phone —
and it's the same surface for work-plane gates.

---

## 9. Roadmap

> **Two rules that hold across every horizon below.**
>
> **The console ships with the capability — there is no separate console track.** A backend
> capability is not done until the console surfaces it. A driver you cannot provision from the
> UI, a change you cannot view, a run you cannot find: those are half-landed features. This is
> why no horizon names console work — it is inside every item, not beside them.
>
> **Notifications are in-app on both sides.** kaambaan notifies for gates, we notify for
> permissions, both in-app, and neither builds a push transport yet. Push, email and Slack are
> a later channel decision for whichever side owns delivery — deferring it is what stops us
> building the same transport twice before we know which side should own it.

### Horizon 0 — The spine (4–6 weeks)

*Nothing new ships. This is the horizon that decides whether the next two years are a
suite or a pile.*

- [x] ~~Close ACP slice 4e Task 3~~ — done 2026-08-11. `v0.1.18` carries all seven assets
      (four binaries + `.service` + `install.sh` + `SHA256SUMS`), matching the build matrix, so
      self-update is sound. Codex live-verified on the Mac: five codex stations detected, each
      advertising `acp`, prompt and reply confirmed through the console. Harness matrix on that
      node — claude-code 25, opencode 8, codex 5, openclaw 1; hermes absent there.
- [ ] **`apn scan`, free and hubless.** Promoted from Horizon 1: it is the only item on this
      roadmap that *acquires users* rather than serving ones we don't have yet, it depends on
      nothing else here, and it lands into a market with 42,000 exposed instances looking for
      it. Runs in parallel with everything below.
- [ ] Promote issue #228 (macOS signing and notarization) to blocking. Unsigned binaries
      that re-prompt on every update are survivable for a console and disqualifying for a
      control plane. *Not* on the critical path for the spike — see below.
- [ ] **The kaambaan bridge spike — do this before committing to anything below it.**
      Register the hub as a kaambaan agent, claim a card, dispatch to a real station running
      a real harness, stream ACP events as activities, block once on a permission gate, and
      complete. Measured against `conformance.test.ts` semantics. **Target a Linux box, not
      the Mac** — #228 means every macOS update re-prompts for TCC permissions, and the one
      experiment whose job is a clean signal about the seam should not be run on the surface
      with a known permissions-friction bug. This either validates §7 or kills it.
- [ ] Land the bridge as **`apps/bridge`** in this monorepo — its own process and deploy,
      sharing the contract packages directly, without paying the cross-repo tax. Extract it
      later if it ever earns its own release cadence; the same "split the repos later" logic
      §5 applies to contracts.
- [ ] Split the contract along plane boundaries — `contract-runtime`, `contract-substrate`,
      `contract-session`, `contract-change`, `contract-identity`. **Workspace-internal only;
      no npm publishing.** The existing files already map almost 1:1, so this is packaging,
      not refactoring. Publishing waits until a consumer outside this monorepo needs it, and
      kaambaan is not that consumer — we speak its wire surface, not its package (§5).
- [ ] **Migrate to zod 4 in the same pass**, since that pass already touches every contract
      file. Cheaper than it looks: only fifteen files import zod across the workspace, and
      `zod/v4` already ships inside the installed `3.25.76`, so it moves incrementally via
      `import { z } from "zod/v4"` with no package bump. The reason is *not* kaambaan interop —
      the seam is wire-level and there is no shared package — it is that zod 3 stops getting
      attention and this only gets more expensive.
- [ ] A **golden-fixture round-trip test** for the Go mirrors: emit JSON fixtures from the zod
      schemas, assert the Go structs unmarshal them losslessly. Ten percent of the codegen
      pipeline for most of its value, and unlike codegen it is justified today — see the note
      under Horizon 2 for why full codegen is not.
- [ ] Give a station attempt a durable identity, carrying kaambaan's `runId` when it came from
      a claim and a local id when it did not. Adopt A2A's state vocabulary verbatim — do not
      invent a parallel outcome enum. The console must keep working with no board attached.
- [ ] Reserve `change` in `contract-change`. A peer entity everything downstream keys off
      costs a schema decision now and a reconciliation later. Delivery adapters can wait for
      Horizon 2; what cannot wait is that the schema never grows a required
      `pull_request_id`.
- [ ] Settle the **shape** of `acp_events` retention and export, even though enforcement ships
      in Horizon 3. That table is now authoritative for transcripts, permission decisions and
      usage, *and* the projection source for kaambaan and A2A, *and* the §11 flight recorder —
      and today it only grows, on the hub's Postgres, with no compaction, archival or export
      path. Partitioning and an archival boundary are schema decisions, and §10's retrofit
      argument applies to them exactly as it does to the run identity.
- [x] ~~Clear the dependabot backlog~~ — done 2026-08-11. Eleven orphaned PRs closed against
      directories and actions purged in P2a/P2c; `gomod` coverage added for the node-agent,
      which had none.
- [x] ~~Fix the branch-flow drift~~ — done 2026-08-11. `CONTRIBUTING.md` now describes
      trunk-based work on `main` gated by the four required checks, which is what has actually
      been happening for three months, with a note on reverting to `develop` → PR → `main` if a
      second contributor appears.

### Horizon 1 — Doors, then substrate (Q4 2026)

*Stop being the only way in, then widen what we can run on. Doors leads because it is the one
item here that is distribution rather than capability.*

- [ ] **Doors — be an ACP *server*.** Any ACP client — Zed, JetBrains, a phone — attaches to
      any station on any machine through the hub, including behind CGNAT. This is the only
      item in the horizon that puts stations in front of people who have installed nothing of
      ours, and it is smaller than it sounds: the hub already terminates ACP sessions, so
      serving is proxying plumbing it already owns.
- [ ] A **`changeset` capability** on the node-agent — package a station's workspace diff
      against a base, ship it to the hub, render it in the console. *Pulled forward from
      Horizon 2:* it waits on nothing here, needs no board and no bridge, and today a change
      made on one of thirty-nine stations can only be seen by walking to that machine. Same
      theme as Doors — make the fleet useful to someone who is not sitting at it.
- [ ] Open the provisioner registry — **single-tenant for now.** Dynamic names, capability
      manifests, optional pause and resume, and a driver conformance suite in CI. Credentials
      stay env-based *behind a resolver interface*; the per-org encrypted store lands with the
      orgs work in Horizon 3. Per-org anything requires MT-1/MT-2, and there is no tenancy in
      the hub at all today — eight schema files, zero `organizationId`, no Better Auth
      organization plugin. Orgs are premature for demand and tenancy is a worse retrofit than
      the run key, so start neither: the resolver costs one small abstraction and buys the
      ordering freedom.
- [ ] **Windows stations.** The intent is that stations run on Linux, macOS *or* Windows, but
      today the release matrix is `linux/{amd64,arm64}` and `darwin/{amd64,arm64}`, and service
      management is systemd plus LaunchAgent. Windows needs a `windows/amd64` target, a service
      integration (SCM or scheduled task), and path/process handling that currently assumes
      POSIX — a piece of work, not a matrix row. Sizing it belongs here, before any plane
      assumes the fleet is already cross-platform.
- [ ] A **`posture` capability** alongside health and logs, so `apn scan`'s findings become
      fleet-visible instead of a local report. This is the missing middle of the posture
      story — Horizon 0 ships a one-shot hubless scanner, Horizon 3 ships continuous posture
      with staged remediation, and nothing joined them.
- [ ] Ship the first driver wave — **generic SSH, then E2B and Fly Machines** — alongside the
      Docker and Cloudflare drivers we already have. Kubernetes `agent-sandbox` moves to the
      second wave (§6). Each must land as an ordinary enrolled station with zero downstream
      special-casing.
- [ ] **Fleet-as-MCP-server — a curated subset, not a mechanical wrap.** The original framing
      ("the zod schemas convert nearly mechanically") is precisely the mistake §7 flags in
      kaambaan's own MCP surface, and it bites harder here: our verbs include lifecycle,
      cleanup and provisioning, and a model holding `cleanup.apply` across 39 stations is a bad
      afternoon. **Enforce it in the contract, not in a hand-maintained allowlist:** every verb
      declares an exposure (`model-safe` / `operator-only`), the MCP surface is generated from
      that declaration, and CI fails on a verb that declares neither. An allowlist rots; a
      required field cannot be forgotten.

### Horizon 2 — The bridge and the change artifact (Q1–Q2 2027)

*Renamed. Most of what this horizon used to contain is already built, in kaambaan, and calling
it "Work" is an invitation for someone to rebuild a board here in six months.*

**Ours:**

- [ ] Harden the bridge from spike to production: fleet-wide agent lifecycle (mint on enroll,
      retire on cleanup), one kaambaan agent per station, conformance run in CI on both sides.
- [ ] Serve an A2A AgentCard per station from the hub, derived from the descriptor. Any
      orchestrator, not only kaambaan (§7).
- [ ] Delivery adapters — `git-remote` first, then `github` / `gitlab` / `forgejo`, and
      `patch`. Ship nothing that makes the `git-remote` path insufficient. Built on the
      `changeset` capability from Horizon 1.
- [ ] In-app permission notifications, so "blocked, waiting for you" is not a forgotten tab.
      No push transport yet — see the rules above §9.

**kaambaan's, and already shipped — feed them, don't rebuild them:** boards and cards, the
task state machine, gates and approvals, attempts comparison, per-attempt metering, GitHub
issue/PR references and sync.

**kaambaan's, and needed for fleet scale:** agent lifecycle at churn, refreshable capability
tags, a fleet-level concurrency cap (§7).

**Opening up to contributors — one bundle, and it has a trigger, not a date:**

- [ ] A descriptor SDK, so new harnesses stop being bottlenecked on us writing Go.
- [ ] Full zod → JSON Schema → Go codegen, enforced in CI.

> **Why these two moved here, together.** They are the same bet — making outside contribution
> safe — and the original roadmap split them across horizons on the strength of a premise that
> isn't true yet. There is no drift bug anywhere in this repo's history: the ACP program
> expanded the contract across five harnesses, with hand-written Go mirrors, and none drifted.
> Nobody is asking to add a sixth harness. Building for contributors before courting them is
> the surface-area risk in §10 wearing a helpful face.
>
> **The trigger, so they don't drift forever:** the first outside request to add a harness, or
> the second person committing. Until then Horizon 0's golden-fixture round-trip test carries
> the drift risk for a fraction of the cost.

### Horizon 3 — Governance across the suite (2027)

*Where it stops being removable.*

- [ ] Orgs — MT-1 through MT-4, **plus the per-org credential store Horizon 1 deliberately
      deferred.** Trigger this when the wedge actually starts pulling teams in — `apn scan` is
      what produces that signal — rather than on a date. The cross-tenant isolation audit
      matters far more once we hold other people's security findings.
- [ ] Fleet permission policy, org-scoped, evaluated centrally, fully audited.
- [ ] Spend accounting and budgets keyed by run. **kaambaan may decide a budget is exceeded;
      only the runtime can enforce it** — terminating a live agent needs the session, and the
      session is ours. The same authoritative/projection split as the ledger (§8).
- [ ] Continuous posture and staged fleet patching with health gates and rollback, built on
      the `posture` capability from Horizon 1.
- [ ] **Ledger lifecycle in force** — retention windows, compaction of ephemeral activity, and
      a verifiable export. "Produce March's agent activity" has to be one command against a
      ledger, not a query someone writes by hand against a table nobody has pruned since 2026.
      The schema for this was settled in Horizon 0; this is the policy and the tooling.
- [ ] Agent identity. **After the bridge, every station carries two credentials** — its
      enrollment credential and its `kbn_` kaambaan token. Bind both to one non-human identity
      on a single rotation schedule, or they rotate on different clocks under different owners,
      which is how this breaks at 3am.

---

## 10. What kills a suite specifically

- **Surface area — by a wide margin the top risk.** Five planes, eight drivers, five
  harnesses, four test suites, one maintainer. The mitigations are structural, not
  heroic: the conformance suite so drivers can't rot silently, the descriptor SDK so
  harnesses are community-carried, codegen so contract drift can't compile, and a hard
  rule that a new plane ships thin or not at all.
- **The join key retrofitted.** If the run identity arrives after the planes that write to
  it, we reconcile four id spaces under load. Now that the work plane is a *separate repo*,
  this is worse than the original framing: reconciling id spaces across two products is
  harder than across two tables. Adopt kaambaan's `runId` rather than minting a rival (§7).
- **Two repos, one owner, silent drift.** kaambaan and AgentPod can diverge with nobody to
  notice, and the failure is quiet — a contract change on one side that the other only
  discovers in production. The mitigation exists already: kaambaan's conformance kit, run in
  CI on *both* sides. The second form of this is duplication by accident — the day AgentPod
  grows a board, or kaambaan grows fleet management, one of them is wasted work.
- **Provider API churn.** Eight substrates means eight vendors shipping breaking changes
  on their own schedule — and one of them, Daytona, already closed its source mid-2026.
  Nightly conformance runs against real accounts, and treat a driver we cannot test as a
  driver we do not ship.
- **Competing with Agent HQ on its own terms.** If the work plane drifts toward general
  project management, we lose to a free bundled product. Keep it dispatch-and-compare.
- **Suite in name only.** The failure mode is five products that share a logo and a login.
  The test is simple and worth applying at every review: can we ask the §3 question and
  get one answer? If not, the join isn't real yet.

---

## 11. Bets worth holding loosely

Explicitly further out and less certain than everything above — but each is reachable
from what's already built.

- **The flight recorder.** Keyed by run, `acp_events` becomes a complete legal record of
  what an agent proposed, was permitted, and did. As NIST's agent standards work and EU
  AI Act obligations land, "produce March's agent activity" becomes a question with
  weight. Most people will build this from logs; we'd build it from a ledger.
- **A hardening benchmark for agent runtimes.** There is no CIS Benchmark for OpenClaw.
  Whoever writes one defines the vocabulary the category audits against, and the scanner
  implementing it becomes the reference by default.
- **Placement.** Once we have runs, substrate capability manifests, and live health for
  every machine, "run this on whichever of my machines is idle, or burst to E2B if none
  are" is a scheduler — Kubernetes for the computers people already own plus the ones
  they rent. Strong idea, wrong horizon.
- **Agents operating the suite.** With the fleet as an MCP server and work as runs, an
  agent can hold the operations of the fleet itself, with the console demoted to approval
  and audit. That is where all five planes actually point.
- **Consumer.** At 369K stars the self-hosted agent is no longer a developer-only object.
  "Your agent is exposed to the internet — fix it," on a phone, is a larger market than
  any console, and it's the same daemon underneath.

---

## Summary

Build the suite. The architecture already wants it — the provisioner drivers hand every
sandbox to the same node-agent, which means one management contract can span a Kubernetes
CRD, a Firecracker microVM, and the laptop on the desk. What's missing isn't a plane; it's
the spine.

But the spine is cheaper than the first draft of this document claimed, because one of the
five planes is already built and living in another repo. The work is not to invent a run
identity — kaambaan has one — it is to **join to it without minting a rival, and to prove
that join against a real harness on a real machine before building anything on top of it.**
So: **run the bridge spike first, adopt kaambaan's `runId` and A2A's states rather than
inventing our own, keep `acp_events` authoritative and everything else a projection of it,
and let every plane added afterwards make the previous four more valuable instead of merely
more numerous.**

---

## Sources

Market and ecosystem claims in §2 and §6 are as of 2026-08-10 and should be re-checked
before they're used to justify a decision.

Claims in §7 about kaambaan are from its code and tests at `573a9ba` (2026-06-22), read
2026-08-11 — **not** from its README or roadmap, which still say "P0 — Foundations" while the
code is through roughly P5/P6.

- [rakeshgangwar/kaambaan](https://github.com/rakeshgangwar/kaambaan) — the work plane. Key artifacts: `packages/contract/src/{primitives,state-machine,verbs}.ts`, `apps/api/src/mcp/`, `apps/api/src/adapters/claude-code.ts`, `apps/api/test/conformance.test.ts`
- [ACP brings JetBrains on board — Zed](https://zed.dev/blog/jetbrains-on-acp) · [Zed — Agent Client Protocol](https://zed.dev/acp)
- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) · [Agent Sandbox docs](https://agent-sandbox.sigs.k8s.io/docs/) · [Agent Sandbox on Kubernetes — Northflank](https://northflank.com/blog/agent-sandbox-on-kubernetes)
- [Daytona vs E2B — Northflank](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes) · [E2B alternatives — Blaxel](https://blaxel.ai/blog/e2b-alternatives-sandbox-environments) · [Agent sandboxing in 2026](https://manveerc.substack.com/p/ai-agent-sandboxing-guide)
- [Introducing Agent HQ — GitHub](https://github.blog/news-insights/company-news/welcome-home-agents/) · [Orchestrating agents with mission control — GitHub](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)
- [The OpenClaw security crisis: 42,000 exposed deployments](https://markets.financialcontent.com/observerreporter/article/marketersmedia-2026-3-1-the-openclaw-security-crisis-42000-exposed-deployments-at-risk) · [138+ CVEs tracked](https://blink.new/blog/openclaw-security-best-practices-2026) · [The AI agent security crisis — Reco](https://www.reco.ai/blog/openclaw-the-ai-agent-security-crisis-unfolding-right-now)
- [Best self-hosted AI agents 2026](https://lushbinary.com/blog/best-self-hosted-ai-agents-hermes-openclaw-ironclaw-compared/) · [Hermes vs OpenClaw — Turing Post](https://www.turingpost.com/p/hermes)
- [Managing parallel AI coding agents 2026](https://nimbalyst.com/blog/best-agent-management-tools-2026/) · [NIST and ISO agent identity governance frameworks](https://nhimg.org/nhi-news/nist-iso-ai-agent-identity-governance-frameworks)
