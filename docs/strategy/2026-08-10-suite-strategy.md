# AgentPod — The Suite: Five Planes, One Join Key

> **Date:** 2026-08-10 · **Status:** Strategy — for discussion
> **Scope:** product direction for AgentPod and the surrounding agentic suite
> **Supersedes:** nothing. Complements the founding [fleet-console design](../superpowers/specs/2026-06-21-agentpod-fleet-console-design.md) (2026-06-21) and revisits its work/runtime split.

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
| 4 | **Work** — what they should do | New (kaambaan) | Initiatives, tasks, runs, stages, gates, review. Linear-shaped, but an assignee can be an agent bound to a runtime and a budget. (§7) |
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
| `contract-work` | initiative, task, run, change, stage, gate, verdict, delivery adapter | work plane, hub, console |
| `contract-identity` | org, actor, agent identity, policy, budget | everything |

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
| `k8s agent-sandbox` | Sandbox CRD | The emerging standard, SIG-backed, pause-resume and warm pools built in — and it ships Hermes and OpenClaw examples. Also our entry into every company already running Kubernetes. | **First** |
| `e2b` | Firecracker microVM | Strongest isolation story and the most mindshare; the provider people name when they say "sandbox" | **First** |
| `generic ssh` | BYO host | Nearly free — cloud-init plus the `install.sh` we already publish. Covers every provider we never write a driver for. | **First** |
| `fly machines` | Per-machine VMs | Cheap always-on; the natural home for a personal Hermes or OpenClaw | Second |
| `modal` · `runloop` · `blaxel` | Hosted sandboxes | Parity with the OpenAI SDK's bundled set; Blaxel resumes paused environments in tens of milliseconds | Second |
| `daytona` | Persistent workspaces | Closest model to always-on agents, sub-90ms create — but its production codebase went closed-source in June 2026, so hosted-only, no self-host story | Third |

> **Hold this invariant.** Every driver's responsibility ends at enrollment. No
> driver-specific paths downstream, no capability that only works on Docker. The day one
> plane needs to know which substrate it's on is the day the suite starts costing N×
> instead of N.
>
> The mirror of this rule on the outbound side — no forge in the work plane's model — is
> in §7. Same failure at the opposite end of the pipe: inbound we refuse to let one
> sandbox provider become the model; outbound we refuse to let one forge become it.

---

## 7. Work: mission control, without fighting Agent HQ head-on

GitHub gives away task assignment with Copilot, across web, VS Code, mobile and CLI. We
do not win that by building a better kanban. We win by dispatching where they
structurally cannot: **heterogeneous harnesses, heterogeneous substrates, and private
hosts.** Agent HQ assigns cloud agents into GitHub's own sandboxes. We can assign a task
to Claude Code on a colleague's workstation, Hermes on a Hetzner box, and Codex in an E2B
microVM — and compare the three.

The corollary is that we must not hand the last mile back. A dispatch layer whose every
output has to become a GitHub pull request has routed around Agent HQ and then delivered
its work to GitHub anyway.

### The model — four objects, not a board

Kanban is a view. The model underneath is a run graph:

- **Initiative** — the unit of intent, syncable with a GitHub issue or a Linear ticket.
  Never ask anyone to migrate their backlog; import it.
- **Task** — a decomposed, assignable unit with an acceptance condition.
- **Run** — one attempt: binds *task + harness + station + session + budget + policy* and
  produces *transcript + diff + cost + verdict*. This is the join key from §3. Runs are
  cheap, comparable, and re-runnable on a different substrate.
- **Change** — the thing that lands. One change accumulates many runs — a first attempt, a
  revision after review, a CI fix — and resolves to a commit against a base. Runs are
  immutable attempts; a change is the mutable object a human tracks across them. "Compare
  three runs and promote one" produces a change; without it, the question of what the
  promoted run *becomes* has no answer.

> **Why `change` is not a sixth plane.** The diff is already in the §3 sentence and already
> a run output — this is an under-specified part of the existing thesis, not a plane the
> strategy forgot. It earns a second entity because its lifecycle outlives the run that
> produced it, and it earns nothing more. §10's rule holds: a new plane ships thin or not
> at all.

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
> day `contract-work` grows a required `pull_request_id` is the day we have swapped one
> vendor's lock-in for another's and lost the reason we routed around Agent HQ at all.

> **The wedge.** The forge owns everything after the merge request. Nobody owns what comes
> before it — twelve candidate diffs from four harnesses on three substrates, and no way to
> compare them. That gap is the visible payoff of the dispatch argument above, and it is a
> comparison view over an artifact store, not a version control system.

### Three things we get almost free

- **Gates are already built.** A stage gate that needs human approval is exactly an ACP
  permission request — same queue, same audit, same modes. The work plane's approval UI is
  a re-skin of the permission UI, not a new subsystem.
- **The shape is already in the schema.** The vestigial `agent_tasks` table from the
  OpenCode era is literally *task → sandbox → session → response → error*. Don't
  resurrect the table — it's Cloudflare-specific and pre-fleet — but it's evidence we
  found this model once already.
- **The diff already has a path off the box.** Stations expose filesystem and terminal
  today, so packaging a workspace change against a base is a capability, not an
  architecture. It also removes an ugly requirement: no station needs push credentials of
  its own for work done on it to become reviewable.

> **The honest risk on this plane.** This is where we have the least differentiation and
> the most competition, and it's the most UI-expensive thing in the suite. Ship it thin:
> runs, changes, comparison, gates, and initiative sync. Resist swimlanes, sprints,
> estimates and roadmaps — every hour spent on project-management features is an hour not
> spent on the four planes nobody else can build.

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

### Approvals that reach a human

The permission queue exists; the missing hop is the notification. A PWA plus push turns
"blocked, waiting for you" from a forgotten tab into something answered from a phone —
and it's the same surface for work-plane gates.

---

## 9. Roadmap

### Horizon 0 — The spine (4–6 weeks)

*Nothing new ships. This is the horizon that decides whether the next two years are a
suite or a pile.*

- [ ] Close ACP slice 4e Task 3 — cut the `v0.1.x` tag, verify release completeness,
      live-verify Codex on the Mac. Record the harness matrix and stop.
- [ ] Promote issue #228 (macOS signing and notarization) to blocking. Unsigned binaries
      that re-prompt on every update are survivable for a console and disqualifying for a
      control plane.
- [ ] Split the contract into the five packages, version them, publish to npm.
- [ ] Add zod → JSON Schema → Go codegen, enforced in CI. The hand-written Go mirrors are
      the crack that widens fastest once other people contribute.
- [ ] Introduce the `run` entity and backfill it across sessions and provisioned runtimes.
      Everything after this depends on it existing.
- [ ] Reserve `change` alongside `run` in `contract-work`. Same argument as the run key — a
      peer entity everything downstream keys off costs a schema decision now and a
      reconciliation later. The delivery adapters can wait for Horizon 2; what cannot wait
      is that the schema never grows a required `pull_request_id`.
- [ ] Clear the dependabot backlog and fix the branch-flow drift — docs say `develop`, the
      last three months went `ui-revamp` → `main`.

### Horizon 1 — Substrate and doors (Q4 2026)

*Widen what we can run on, and stop being the only way in.*

- [ ] Open the provisioner registry: dynamic names, capability manifests, per-org
      credentials, optional pause and resume, and a driver conformance suite in CI.
- [ ] Ship three drivers — Kubernetes `agent-sandbox`, E2B, and generic SSH. Each must land
      as an ordinary enrolled station with zero downstream special-casing.
- [ ] **Doors:** be an ACP *server*. Any ACP client — Zed, JetBrains, a phone — attaches to
      any station on any machine through the hub, including behind CGNAT.
- [ ] **Fleet-as-MCP-server.** Wrap the contract verbs as MCP tools; the zod schemas convert
      nearly mechanically. Agents can then operate the fleet.
- [ ] `apn scan`, free and hubless. Independent of everything else here — ship it whenever
      there's a gap.
- [ ] A descriptor SDK, so new harnesses stop being bottlenecked on us writing Go.

### Horizon 2 — Work (Q1–Q2 2027)

*The plane that makes it a suite rather than infrastructure.*

- [ ] Initiative / Task / Run / Change, over the sessions and stations we already have.
- [ ] A `changeset` capability on the node-agent — package a station's workspace diff
      against a base and ship it to the hub. Reuses filesystem and terminal.
- [ ] Gates wired to the existing permission queue — same audit trail, same approval surface.
- [ ] Board and run-comparison views. Same task, three harnesses, three substrates, compare
      diffs and cost, promote one into a change.
- [ ] Delivery adapters — `git-remote` first, then `github` / `gitlab` / `forgejo`, and
      `patch`. Ship nothing that makes the `git-remote` path insufficient.
- [ ] Initiative sync adapters — GitHub Issues, Linear, and standalone with no upstream at
      all. Import backlogs; never demand migration; never require an upstream.
- [ ] Mobile PWA with push, covering both permission answers and stage gates.

### Horizon 3 — Governance across the suite (2027)

*Where it stops being removable.*

- [ ] Orgs — MT-1 through MT-4. Now, when the wedge is pulling teams in. The cross-tenant
      isolation audit matters far more once we hold other people's security findings.
- [ ] Fleet permission policy, org-scoped, evaluated centrally, fully audited.
- [ ] Spend accounting and budgets keyed by run, enforceable mid-run.
- [ ] Continuous posture and staged fleet patching with health gates and rollback.
- [ ] Agent identity — each station bound to a non-human identity with short-lived
      credentials.

---

## 10. What kills a suite specifically

- **Surface area — by a wide margin the top risk.** Five planes, eight drivers, five
  harnesses, four test suites, one maintainer. The mitigations are structural, not
  heroic: the conformance suite so drivers can't rot silently, the descriptor SDK so
  harnesses are community-carried, codegen so contract drift can't compile, and a hard
  rule that a new plane ships thin or not at all.
- **The join key retrofitted.** If `run` arrives after the work plane, we reconcile four
  id spaces under load. This is the single highest-leverage ordering decision in the
  document.
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
CRD, a Firecracker microVM, and the laptop on the desk. What's missing isn't a plane,
it's the spine: **ship the `run` entity and the split contracts before anything else, and
every plane added afterwards makes the previous four more valuable instead of merely more
numerous.**

---

## Sources

Market and ecosystem claims in §2 and §6 are as of 2026-08-10 and should be re-checked
before they're used to justify a decision.

- [ACP brings JetBrains on board — Zed](https://zed.dev/blog/jetbrains-on-acp) · [Zed — Agent Client Protocol](https://zed.dev/acp)
- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) · [Agent Sandbox docs](https://agent-sandbox.sigs.k8s.io/docs/) · [Agent Sandbox on Kubernetes — Northflank](https://northflank.com/blog/agent-sandbox-on-kubernetes)
- [Daytona vs E2B — Northflank](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes) · [E2B alternatives — Blaxel](https://blaxel.ai/blog/e2b-alternatives-sandbox-environments) · [Agent sandboxing in 2026](https://manveerc.substack.com/p/ai-agent-sandboxing-guide)
- [Introducing Agent HQ — GitHub](https://github.blog/news-insights/company-news/welcome-home-agents/) · [Orchestrating agents with mission control — GitHub](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)
- [The OpenClaw security crisis: 42,000 exposed deployments](https://markets.financialcontent.com/observerreporter/article/marketersmedia-2026-3-1-the-openclaw-security-crisis-42000-exposed-deployments-at-risk) · [138+ CVEs tracked](https://blink.new/blog/openclaw-security-best-practices-2026) · [The AI agent security crisis — Reco](https://www.reco.ai/blog/openclaw-the-ai-agent-security-crisis-unfolding-right-now)
- [Best self-hosted AI agents 2026](https://lushbinary.com/blog/best-self-hosted-ai-agents-hermes-openclaw-ironclaw-compared/) · [Hermes vs OpenClaw — Turing Post](https://www.turingpost.com/p/hermes)
- [Managing parallel AI coding agents 2026](https://nimbalyst.com/blog/best-agent-management-tools-2026/) · [NIST and ISO agent identity governance frameworks](https://nhimg.org/nhi-news/nist-iso-ai-agent-identity-governance-frameworks)
