# Workspace authority: the hub answers to the workspace, not to a seat

2026-10-22. Status: draft for review. Covers agentpod (hub, contract, console) and accounts.

## The problem, as a fresh user meets it

A person signs up for the suite, creates a workspace (or accepts an invitation into one), opens
the AgentPod console, and is told **"Admin access required"**. Being the workspace's owner at
Accounts means nothing to the hub. The only way past it today is a row in the hub's database:

```sql
INSERT INTO hub_operators (principal_id) VALUES ('prn_…');
```

No self-serve user will ever do that, and none should: on a shared hub, `hub_operators` controls
**every** workspace's fleet. The seat is right to be out of reach. What is missing is anything in
its place.

Found on staging (workbench), signing in as a fresh operator account.

## What the hub already has

More than the symptom suggests:

- Every plane token carries `org` (the active workspace for a human, the owning workspace for an
  agent or service). `verifyPlaneBearer` (`apps/hub/src/auth/hub-token.ts`) maps it to a local
  tenant on every request (`tenantForOrg`, first sight creates `fleet_…`), and `AuthUser.tenantId`
  carries it.
- `apps/hub/src/db/tenant-scope.ts` already isolates about forty tables by `tenant_id`
  (`TENANT_SCOPED_TABLES`), with `tenantScope()` and `assertTenantId`.

What breaks it:

1. **No role reaches the hub.** Accounts' tokens carry `org` but not the person's role in it
   (`buildClaims`, accounts `src/issuer/claims.ts`, only checks that a member row exists). No
   service endpoint returns the role either. That is why D4 (P3 plan) made admin a hub-local seat.
2. **Per-user filters on top of the tenant.** Nodes, stations, runtimes and most of their
   satellites are listed with `eq(x.userId, userId)` as well as the tenant: a teammate in the same
   workspace sees none of the workspace's fleet.
3. **The tenant is often not the caller's.** `resolveTenantForUser()` (`apps/hub/src/auth/tenant.ts`)
   always returns `BOOTSTRAP_TENANT_ID` and has 19 callers, among them `mintEnrollmentToken`.
   On production and staging that tenant is mapped to `org_00000000000000000000` (Super Jackfruit
   Labs). **A node enrolled by any other workspace would land in SJL's fleet.** Nobody outside SJL
   has enrolled yet, so nothing has leaked; the first self-serve workspace would.

## Decisions

**W1. Authority is the workspace role.** Accounts adds the caller's role in `org` to every human
token: `orgRole: "owner" | "admin" | "member"`. The hub reads it. Within its tenant:

| Role | May |
|---|---|
| member | see the workspace's nodes, stations and agents; use stations (chat, sessions of their own) |
| admin, owner | everything a member may, plus enrol and remove nodes, update them, set telemetry, create and assign agents, manage bridge agents and board links, issue station forge access, read the workspace's audit log |

The hub keeps no copy of the role: a token without `orgRole` (minted before Accounts ships it) is
treated as **member**, which fails closed.

**W2. `hub_operators` stays, for the whole hub only.** It gates what no single workspace owns:
hub-wide provider settings (`/api/admin/settings*`, transcription, speech) and anything that spans
tenants. A hub operator is **not** implicitly an admin of every workspace; a cross-workspace act is
named as one. On the hosted hub the seat belongs to SJL staff.

**W3. The seat is set from configuration, never from SQL.** `HUB_OPERATORS=prn_…,prn_…` is read
at boot and reconciled into `hub_operators` (added; removing a principal from the list removes
its row). A self-hosted hub names its operator in its env file; nobody opens psql. The manual
`INSERT` leaves `docs/OPERATING.md`.

> **W2/W3 superseded 2026-10-22 (operator approved).** Owners and admins of the hub's *home
> workspace* — the org that owns the hub's service credential, learned at boot from the `org`
> claim of a service token the plane mints for it — are hub operators. `hub_operators` /
> `HUB_OPERATORS` stay as an optional, additive list for people outside that workspace (unchanged
> reconcile semantics). Home workspace unknown (plane down) = nobody derived, fail closed;
> `HUB_HOME_ORG` may pin it and a mismatch with the credential refuses the boot. A self-hosted hub
> needs zero bootstrap; on the hosted hub the service principal is in SJL's org, so a customer's
> owner never operates it, and W2's "not an admin of every workspace" still holds.

**W4. Resources belong to the workspace.** A node, station, runtime or enrollment token is the
tenant's. `user_id` stays, renamed in meaning to *who enrolled or created it* (audit), and stops
being a read filter. Two things stay per person, because they are a person's own: ACP sessions
(and their transcripts), and live-activity tokens.

**W5. The tenant always comes from the request.** Every caller of `resolveTenantForUser()` takes
the tenant from the authenticated request (`resolveTenantId(c)`), or from the node or token row it
is acting on. `resolveTenantForUser` is deleted. Enrollment tokens are minted in the caller's
tenant, and a node inherits the token's tenant (already true).

**W6. Agents and services are unchanged.** Their authority is already the token's `org`,
`mayDispatch` and grant scopes; a workspace's agent cannot reach another workspace's stations
because the tenant filter is the same one.

## Accounts changes

- `buildClaims` reads `member.role` for a human with an `org` and adds `orgRole`. That covers the
  OAuth access token (web clients), device tokens (CLI) and `token:assert`. Agent and service
  tokens get none.
- `PrincipalView` gains `role` for humans (`GET /api/principals/:id`, `GET /api/principals?kind=human`),
  so a service can ask without a token in hand.
- Contract (`docs/superpowers/specs/2026-10-06-issuer-contract.md` §2): `orgRole` row; products
  must treat a missing `orgRole` as `member`.
- Freshness: the role is read at mint time. Access tokens live 300 s; an OAuth refresh re-reads
  it, so a demotion takes effect at the next refresh. That matches how membership loss already
  works (§3.1).

## Hub changes

- **Contract:** `OrgPlaneTokenClaims` gains optional `orgRole`.
- **`AuthUser`** gains `org` (the raw `org_` id) and `workspaceRole` (`orgRole` or `member`).
- **Helpers** (`apps/hub/src/auth/workspace-authority.ts`): `workspaceRole(c)`,
  `requireWorkspaceAdmin(c)` (owner or admin, else 403 `{ error: "workspace_admin_required" }`),
  `isHubOperator(c)`. `requireAdmin`/`adminMiddleware` are replaced by one of the two at each site.
- **Gate map:**

| Route | Today | After |
|---|---|---|
| `GET /api/admin/settings`, `/settings/transcription*`, `/settings/speech*` | seat | seat (W2) |
| `GET /api/admin/stats` | seat | workspace admin, counts for the tenant |
| `GET /api/admin/audit-log` | seat | workspace admin, rows for the tenant; seat for all |
| `GET /api/admin/principals`, `POST /api/admin/agents`, `PUT\|DELETE /api/admin/stations/:id/agent` | seat | workspace admin |
| `/api/admin/bridge/agents*`, `PUT /api/admin/bridge/boards/:id`, `/api/admin/grants*` | seat | workspace admin |
| `GET\|POST /api/nodes/telemetry`, `POST /api/nodes/update-all` (today ungated) | seat / none | workspace admin |
| `POST /api/enrollment-tokens`, `DELETE /api/nodes/:id` (control-pair `requireFleetGrantReach`) | seat | workspace admin (the control pair, when enforced, still applies on top) |
| station forge-api mutations | seat + `requireIssueCredentials` | workspace admin + `requireIssueCredentials` |
| station forge-api reads | owner or seat | workspace member |
| node, station, runtime, skill reads | owner (`userId`) | workspace member |

  The `/api/admin` prefix stays for now (the console calls it); a later rename is cosmetic.
- **Queries:** every owner filter listed in the survey (node-registry, node-removal,
  station-registry, fleet, mcp-proxy, runtimes, skill-*, salaam-dispatch, station-setup and the
  single sites) drops `userId` and keeps `tenantScope`, except ACP sessions and live-activity
  tokens (W4). `ownsNode`/`ownsStation` become "in my tenant".
- **`GET /api/me`** returns `{ id, email, org, workspaceRole, isWorkspaceAdmin, isHubOperator, isAdmin }`.
  `isAdmin` is kept for an old console and equals `isWorkspaceAdmin || isHubOperator`.
- **Boot:** reconcile `HUB_OPERATORS` (W3).

## Data migration

No row changes owner: today every row on a deployed hub is in the bootstrap tenant, which is
mapped to SJL's workspace, and every existing user is in that workspace. What the migration does:

1. Verify the premise before acting: count rows whose tenant is not mapped to an org with
   members, and refuse if any exist (a hub that already holds a second workspace's rows needs a
   person, not a script).
2. Nothing else moves. Removing the `userId` filters only widens what SJL's own members see, which
   is the intent.
3. Production: `HUB_OPERATORS` is set to today's `hub_operators` rows before the release, so the
   reconcile changes nothing.

The release deploy backs the database up first (`deploy/release.sh`).

## Console changes

- `role === "admin"` becomes two flags from `/api/me`: workspace admin (fleet actions, agents,
  bridge, grants, the Admin section's workspace pages) and hub operator (the Settings pages:
  transcription, speech).
- A member sees the fleet with its admin actions hidden and one line saying who can do them
  ("Workspace admins can enrol nodes. Ask an owner or admin of {workspace}.") instead of a 403 card.
- The Admin layout's probe (`getAdminStats`) keeps working: it now answers for workspace admins.
- Mockups first for the member view and the split Admin section.

## Order of work

Each step ships alone, deploys to staging on merge, and is walked through there as a fresh user.

1. **accounts:** `orgRole` claim, `PrincipalView.role`, contract row. Tests: each token type
   carries or omits it; a demoted member's next token says `member`.
2. **hub, security first:** W5 (the tenant from the request everywhere; delete
   `resolveTenantForUser`), with a regression test that an enrollment by a second workspace lands
   in that workspace's tenant. No change in authority yet.
3. **hub, authority:** contract `orgRole`, `AuthUser` fields, helpers, `/api/me`, the gate map,
   `HUB_OPERATORS` reconcile, migration premise check.
4. **hub, reads:** drop the owner filters (W4), with tests that a second member of a workspace
   sees its nodes and a member of another workspace sees nothing.
5. **console:** the two flags, the member view, the split Admin section (after mockups).
6. **docs:** OPERATING.md (no manual INSERT), DEPLOYMENT.md (`HUB_OPERATORS`), the P3 plan's D4
   marked superseded by this.

## Tests that must exist (and fail on a revert)

- A second workspace's enrollment token, node and station live in its own tenant.
- A member of workspace A cannot read or act on workspace B's nodes, stations, agents or audit.
- A workspace member sees the workspace's nodes; a workspace admin can enrol and remove; a member
  gets 403 `workspace_admin_required` on each admin route in the gate map.
- A token without `orgRole` is a member.
- A hub operator who is a member of workspace A is not an admin of workspace B.
- `HUB_OPERATORS` adds and removes seats at boot.
- ACP sessions stay private to their person within a workspace.

## Not in scope

Teams, custom roles, per-resource permissions, many workspaces per fleet, and the `/api/admin`
rename. The organization-plane design defers the first four until grant lists get long.
