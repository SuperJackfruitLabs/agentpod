# Forge API access: live acceptance runbook

Status: written, **not yet run**. Nothing below has been observed on a live hub, node, forge or
provider. Everything marked `UNVERIFIED` is a guess the run must confirm or refute.

Companion helper: `scripts/forge-api-acceptance.sh` (tested against stubs only:
`scripts/forge-api-acceptance.test.sh`). Design: `docs/superpowers/specs/2026-10-17-forge-api-access-design.md`.
Operator documentation of the feature: `docs/OPERATING.md` section 12.

Rules for the whole run:

- Never put a token value in a command line, a file you commit, this document, an issue, a PR or
  the transcript. The helper reads values from an environment variable or a descriptor and prints
  only file names, counts and HTTP status codes.
- Do not run anything here against a production station. Do not file the Step 5 issue until the
  operator says so, in words, in that conversation.
- Record every observation in the findings table (Step 6), including the ones that match.

## 0. Preconditions

Tick each one. A missing item means stop, not improvise.

| # | Precondition | How to check |
|---|---|---|
| P1 | Hub has `FORGE_URL` and `FORGE_ADMIN_TOKEN` set. Without them every `forge-api` route answers 503 and the reconcile sweep does not run (OPERATING.md 12a). The admin token needs permission to create and delete tokens for other users. | On the hub host: `forge-api-acceptance.sh preflight` (reports set/unset only). An authenticated `fleet stations forge-api list --station <id>` must not answer 503. |
| P2 | The node runs as **root on Linux with systemd**. A non-root or non-Linux node does not advertise `forge.api` and answers `capability-missing` / `station-instance-unavailable` (by design, no shared fallback). | `ssh node id -u` prints `0`; `uname` prints `Linux`. |
| P3 | `stk` on the node is at or after the supertoolkit PR #20 release **and** that PR is merged and released. Needs `stk install --unit-name`, `stk doctor --json`, `stk doctor --probe --json`, `stk env`, `stk reload`, `stk verify`, `stk audit`. | `ssh node stk version`. Confirm PR #20 is merged and the tag contains commit `b4be3d4` (`--unit-name`). If it is not released, STOP: this run cannot start. |
| P4 | A **non-production** station (not Super Chotu), occupied by a **test agent account** on the configured Forgejo, and a **scratch repository** the account can read. Create a second, different scratch repository the account can also read (used for the confinement canary). | `fleet stations forge-api list --station <id>` is empty. |
| P5 | **Agent uid mapping.** Either each station's agents run as their own OS user and the node config maps them (`forgeApi.stationUids`: station id to uids), or the operator explicitly acknowledges shared uids (`forgeApi.allowSharedAgentUid`, `AGENTPOD_ALLOW_SHARED_AGENT_UID=1`, or `forge-api setup --station <id> --allow-shared-agent-uid`). A station that is not listed is taken to run as the **node's own uid**. For the cross-station test (section 3) two stations on one node need two distinct non-root uids. With the acknowledgement the isolation is reported `same-user` with `isolationDetail: shared-uid`, and section 3 is expected to show the weaker result. | Read the node config; record the mapping or the acknowledgement in the findings table. |
| P6 | **Harness path chosen and whether it is wired.** Wired: ACP sessions and terminals the node spawns (env at spawn), and per-profile Hermes **user** units (`hermes-gateway-<profile>.service`, node-owned env file plus drop-in). **Not wired**: the root `hermes` gateway and OpenClaw's single gateway (they serve several stations). The test station must use a wired path, otherwise `verify` answers `not-wired:` and cannot reach `verified`. Say which one you use. | Record the harness, the path (`spawn` or `gateway`), and `bypass.paths` from the first `verify`. |
| P7 | An `AGENTPOD_ACCEPT_*` environment prepared for the helper (section 6) and an operator seat on the hub. Every verb except `list` also needs the control pair's reach over the station's agent (owning the station is not enough, 403). | `fleet` is signed in as the operator. |

Naming used below: `$STATION` is the station id, `$NODE` the ssh target, `$INST` the station's stk
instance name (`stk-<slug>-<hash>`, printed by `sudo agentpod-node forge-api setup --station $STATION`
as `instance:` and recorded in the node registry
`/var/lib/agentpod/forge-api/stk-instances.json`). Per-instance paths on the node:

| What | Path |
|---|---|
| State directory (store, `*.cred`, `proxy.key`, `audit.log`) | `/var/lib/$INST` |
| Policy file | `/etc/$INST/supertoolkit.yaml` |
| Runtime directory, control socket | `/run/$INST`, `/run/$INST/stk.sock` |
| systemd unit | `$INST.service` |
| Harness env files (Hermes user units) | `/var/lib/agentpod/forge-api/harness-env/$INST/` |
| Unit drop-in | `~/.config/systemd/user/<unit>.d/90-agentpod-forge.conf` in the agent's home |

To act as the instance on the node, run stk with the instance's own environment, as its unit does:

```sh
sudo -u "$INST" env STK_HOME="/var/lib/$INST" STK_CONFIG="/etc/$INST/supertoolkit.yaml" \
  STK_SOCKET="/run/$INST/stk.sock" stk <command>
```

(`STK_HOME`, `STK_CONFIG` and `STK_SOCKET` must always be set, or stk falls back silently to a
user config directory and reports the wrong instance.)

## 1. Canaries marked unverified

Do these first. Each can invalidate the design's assumptions. Record the exact observation.

### C1. Does Forgejo accept `Authorization: Bearer` as well as `token`?

The node writes scheme `token` for Forgejo and Gitea (documented form); `bearer` is UNVERIFIED.
Use a scratch personal access token you hold (never a production credential):

```sh
export AGENTPOD_ACCEPT_OLD_TOKEN='<scratch PAT>'          # typed or pasted, not echoed
for s in token bearer; do
  AGENTPOD_ACCEPT_AUTH_SCHEME=$s ./scripts/forge-api-acceptance.sh old-token-401 --url "$FORGE_URL/api/v1/user"
done
unset AGENTPOD_ACCEPT_OLD_TOKEN
```

The helper prints only the status. Expected: `200` for `token`; `200` for `bearer` (the
open question). If `bearer` is 401, record it: nothing in the node depends on it today, but
the GitHub/Bitbucket `bearer` assumption is separate and untouched.

### C2. Preset path coverage on live Forgejo

The `read`, `issues`, `pull-requests`, `maintain` presets live in stk's provider knowledge.
Their paths and scopes were written from API descriptions and are UNVERIFIED against this
Forgejo. After Step 1 grants `read`, through the proxy as the agent (section 2, 1c) request: the
identity endpoint `/api/v1/user`, `/api/v1/repos/<owner>/<repo>`, `/issues`, `/pulls`,
`/contents/<path>`, `/branches`, `/labels`, `/raw/<ref>/<path>`. Expected: all `200`. Record
each status; a `403 ... rule` is a preset that is too narrow, a request that should have been
refused but was allowed is a preset that is too wide. Repeat with `issues` (create an issue in the
scratch repo as the agent, comment, edit labels; `DELETE` must be 403) before using the preset
elsewhere. Use `policy` to change presets (no new credential): `fleet stations forge-api policy
--station $STATION --grant $GRANT --preset issues`.

### C3. Is a minted token confined to the granted repositories?

Forgejo access tokens are scoped by category (`read:repository`, ...), not by repository.
Whether the hub's minted token is restricted to the listed repositories is UNVERIFIED, and until
this is checked the broker's rules are the only repository restriction (the design says so for
`write:repository` too).

1. Grant `read` on scratch repo A only (Step 1).
2. Ask the agent's account (not the token) what it can see: as admin,
   `GET $FORGE_URL/api/v1/repos/<owner>/<repo-B>` with an admin credential must be `200`
   (the account can read B).
3. Through the proxy as the agent: `GET .../repos/<owner>/<repo-B>`. Expected (by the broker's
   rules): `403` naming a rule. That proves the broker confines; it does **not** prove the token
   is confined.
4. To test the token itself you need its value, which the design hides. If you can obtain a
   token of the same scopes for the same account **that you minted yourself** (a scratch token, not
   the grant's), call repo B directly with it from outside the proxy. `200` means the provider does
   not confine by repository: record `provider-does-not-confine` and treat the broker rules as
   the sole boundary in the findings.

### C4. `GET /admin/users/{u}/tokens` listing

Orphan cleanup depends on the hub being able to list the account's tokens. UNVERIFIED.

```sh
curl -sS -H @- "$FORGE_URL/api/v1/users/$AGENT_LOGIN/tokens" <<<"Authorization: token ${ADMIN_PAT}" | jq 'map({id,name,token_last_eight,scopes})'
```

(That form puts the credential in a heredoc, not argv. Use an admin credential you hold, and the
path variants `/api/v1/admin/users/$AGENT_LOGIN/tokens` and the basic-auth form, since Forgejo lists a
user's tokens with the user's own basic auth.) Record which form answers `200`, whether the list
carries a name and `token_last_eight`, and whether the hub's tokens are recognisable by name.
`token_last_eight` is also the only handle on a minted token's value (see 2e).

### C5. Root-only isolation test on Linux

stk `doctor` makes the access attempts (re-runs itself as each agent uid) only when run as root.
UNVERIFIED on a live instance.

```sh
sudo -u "$INST" env STK_HOME=... STK_CONFIG=... STK_SOCKET=... stk doctor --json   # as the unit would
sudo env STK_HOME=/var/lib/$INST STK_CONFIG=/etc/$INST/supertoolkit.yaml STK_SOCKET=/run/$INST/stk.sock \
  stk doctor --json
```

Expected from the root run: `isolation.level: separate-user`, `method: mode-bits+access`, with the
agent uid(s) listed. Record the method. If the level is `same-user` or `unknown`, copy the
reasons. Expected from the non-root run: the method says the access step was skipped.

### C6. `stk install --unit-name` and doctor "separate-user" after the unit starts

The node ran these only against stubs. After `sudo agentpod-node forge-api setup --station $STATION`
(or the first deliver), check:

```sh
systemctl status "$INST" --no-pager | head -12     # active (running), User=$INST
ls -ld /var/lib/$INST /etc/$INST /run/$INST        # config dir created by install?
sudo -u "$INST" env STK_HOME=... STK_CONFIG=... STK_SOCKET=... stk doctor --json
```

Record: did install create `/etc/$INST` (UNVERIFIED), did the unit start without a manual
`systemctl enable --now` (the node does this, stk install does not), and what doctor says once the
unit is up.

### C7. Does the Hermes gateway honour the drop-in proxy and CA variables?

Only if P6 used a Hermes user unit. UNVERIFIED. After the first grant:

```sh
# as the station's agent uid
systemctl --user cat hermes-gateway-<profile> | head -20      # drop-in 90-agentpod-forge.conf present
systemctl --user restart hermes-gateway-<profile>             # needsRestart: the node never restarts it
systemctl --user show hermes-gateway-<profile> -p Environment -p EnvironmentFiles  # names only
```

Then drive one forge call from the running gateway (e.g. ask the agent to read the scratch repo
through its normal tool). Expected: the call arrives at the broker (an `stk audit` row appears for
it) and succeeds. If the gateway ignores the variables the row is missing and the call gets a
placeholder 401: record `gateway-ignores-proxy-env` and the Hermes version.

### C8. Does the user manager read an agent-owned 0600 env file?

The drop-in's `EnvironmentFile` is owned by the station's agent uid, mode 0600, under a directory
the node created. The user systemd manager runs as that same uid, so it should read it. UNVERIFIED.

```sh
ls -ln /var/lib/agentpod/forge-api/harness-env/$INST/               # owner = agent uid, mode 0600
journalctl --user -u hermes-gateway-<profile> -n 30 --no-pager      # no "Failed to load environment files"
```

Record the owner uid, mode and the journal line (never the file content). The unit that reads the
file MUST run as the station's agent uid, otherwise an agent-writable file feeds a privileged
process; say what `User=` it runs as.

## 2. Steps 1 to 4 (per-station design)

Setup shared by the steps:

```sh
export STATION=...  NODE=...  GRANT=...   # fill in
./scripts/forge-api-acceptance.sh preflight
fleet stations forge-api list --station "$STATION"
```

### Step 1. Grant, deliver, verify, read, refuse, leak-check

**1a. Grant a read preset on the scratch repository for the test agent**

```sh
fleet stations forge-api grant --station "$STATION" --provider forgejo \
  --instance "$FORGE_URL" --repo <owner>/<scratch-repo> --preset read
```

Expected: the grant appears in `list`, moves `delivered` and then `verified`. The node creates
the station's stk instance at its first deliver/status (user `stk-...`, unit, state, port from
8900-8999). Watch `list` until it settles; record the instance name, the ack's `isolation`
(`separate-user` expected; `same-user` with `shared-uid` only under the acknowledgement) and
`needsRestart` (if `true`, restart the station from lifecycle and note it; **the hub does not
surface `needsRestart` yet**, read it from the node log or the deliver ack).

**1b. Verify and read the coverage note**

```sh
fleet stations forge-api verify --station "$STATION" --grant "$GRANT"
fleet stations forge-api list --station "$STATION" --json
```

Expected for a wired path: `verified`. The hub's gating (H10) is:

| Verify result | Hub state |
|---|---|
| `bypass` reports `bypassed` for any client | `failed` (even if it was `verified` before) |
| `ok: false`, reason `not-wired:` (or any reason the node cannot judge) | never `verified` (inconclusive) |
| `ok: true`, `bypass.brokered: false` | stays/returns `delivered` with `coverage-incomplete: ...` in the reason |
| `ok: true`, `brokered: true`, `measured: partial` | `verified` with `coverage: partial (untested: ...)` in the reason |
| `ok: true`, `brokered: true`, `measured: complete` | `verified` |

**`measured: partial` is the expected result of this run**: the station's own harness client is
`untested` (no safe non-interactive probe ships for any of the eight harnesses), and an untested
client is never evidence. So expect `verified` with `coverage: partial (untested: <harness>)`.
Record `bypass.clients`, `bypass.paths`, `bypass.brokered`, `bypass.measured`. A `brokered:false`
here is a finding, not a pass. Known limits: the coverage note lives in the grant's reason and is
replaced by a later lifecycle reason (defect D6), and the status acks carry no `paths` or
`wiringBlocked` (defect D5), so read those from the verify ack. The probe takes up to 45 s, the
hub allows 90 s (`FORGE_VERIFY_TIMEOUT_MS`); a clean result is cached 60 s per station.

**1c. A real repository read through the proxy, as the agent**

On the node, in the agent's own brokered environment (the same environment its harness got; do
not extract the proxy key into your notes):

```sh
# run inside the agent's brokered shell, e.g. a terminal session on the station
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: token $FORGEJO_TOKEN" \
  "$FORGE_URL/api/v1/repos/<owner>/<scratch-repo>"                # 200
curl -sS -H "Authorization: token $FORGEJO_TOKEN" "$FORGE_URL/api/v1/user" | jq -r .login   # the test agent's login
```

`$FORGEJO_TOKEN` holds the placeholder `stk:ref:<service>:v1`, never a token (the variable name is
`FORGEJO_TOKEN` unless two grants share it, then `AGENTPOD_FORGE_<first 8 of grantId>_TOKEN`).
Expected: `200` and the intended account's login. Also run `echo "${FORGEJO_TOKEN:0:9}"` and
confirm it prints `stk:ref:` (the placeholder), and that `env | grep -c ^HTTPS_PROXY` is 1.

**1d. A request outside the preset gets 403 and an audit row naming the rule**

```sh
# same brokered shell
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: token $FORGEJO_TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"acceptance-denied-probe"}' \
  "$FORGE_URL/api/v1/repos/<owner>/<scratch-repo>/issues"          # 403 under preset read
```

Then from the operator machine:

```sh
./scripts/forge-api-acceptance.sh --ssh "$NODE" --instance "$INST" audit "$STATION" --tail 20
```

Expected: a row for `POST .../issues` denied by a rule, with a rule id in the output. The
audit file is `/var/lib/$INST/audit.log`; `stk audit` is the reader. The exact row format and the
presence of `--json` for `stk audit` are UNVERIFIED here (the stk README shows the plain table):
record a sample row with the credential column as printed. Expected absence: no token value in
the row. Also confirm the request never reached the forge: the scratch repo has no new issue.
Repeat for `DELETE` (denied in every preset) and for `/graphql` (denied unless
`--allow-graphql`).

**1e. The token is absent everywhere**

The helper searches for the **real value** without printing it. Where the value comes from:

- **Supplied-mode grant (recommended for this check):** create a scratch personal access token on
  the forge for the test account, keep it in your password manager, and make a second grant with
  `--mode supplied --expect-login <login>`, piping the value on stdin. You then hold the real value.
  `pbpaste | fleet stations forge-api grant ... --mode supplied ...` (the clipboard is the channel,
  nothing is echoed).
- **Minted grant:** the design hides the value from everyone, so you cannot search for it. The
  provider shows `token_last_eight` (C4). Search for those eight characters as a **weak** check
  (the helper's minimum length is eight) and say so in the findings: a hit on eight hex-like
  characters needs a human look, an absence is weak evidence.

Pass the value on a descriptor or from the environment, never an argument:

```sh
# bash: the value comes from your password manager into descriptor 9, never into history or argv
exec 9< <(pass show forge/acceptance-scratch-pat)            # any command that prints the value
./scripts/forge-api-acceptance.sh --token-fd 9 token-absence "$STATION" \
   --target /path/to/hub-db-dump.sql \
   --target /var/log/hub \
   --target /path/to/transcript-dir \
   --ssh "$NODE" --node-target /var/log/agentpod --node-target /var/lib/agentpod \
   --node-target "/var/lib/$INST" --node-target "/etc/$INST"
exec 9<&-
```

What each target is, and how to produce it without leaking:

| Target | How |
|---|---|
| Hub database | `pg_dump` the `station_forge_api_grants` table and the audit tables into a file in a `mktemp -d` directory (umask 077), search it with `--target`, delete it. Do not paste the dump anywhere. |
| Hub logs | the hub's log directory or exported log file for the run window (see `docs/DEPLOYMENT.md`) |
| Node logs | `--node-target` the node log directory (`apn logs` source) over ssh |
| stk store dir | `--node-target /var/lib/$INST` (sealed ciphertext; a hit means plaintext at rest) and `/etc/$INST` (policy has placeholders only) |
| Harness config and env files | `--node-target /var/lib/agentpod/forge-api/harness-env/$INST` and the agent's `~/.config/systemd/user` |
| Transcript | the harness transcript of the Step 1c/1d sessions, exported to a file, as `--target` |

Expected: `token-absence: the token value was not found in any searched file`, exit 0. Any `HIT`
line names a file and a count; treat the token as exposed, rotate it, record the file, file a
defect. The helper skips binary files (`grep -I`), so also list the stk store directory
(`residue`, below) and note that binary files were not searched. The helper refuses a token
shorter than eight characters. It never prints matching lines.

Also confirm the **proxy key** (not a token) is not in logs: it is a different secret. Take it
from `sudo -u $INST ... stk env` into a descriptor the same way and search the same targets;
the only expected place is the harness environment and the node-owned env file.

### Step 2. Rotate, then revoke

**2a. Rotate**

```sh
fleet stations forge-api rotate --station "$STATION" --grant "$GRANT"
```

Expected: a new minted token is sealed and delivered, `list` returns to `verified` (verify again),
the old token is revoked at the provider. Check on the provider (C4 listing): the grant's token
name appears once, with a different `token_last_eight` than before (note both eight-character
suffixes; they are not secrets in the sense of access, but do not publish them either).

**2b. Revoke**

```sh
fleet stations forge-api revoke --station "$STATION" --grant "$GRANT"
fleet stations forge-api list --station "$STATION"      # revoking, then revoked
```

Expected: the node drops the policy entry and forgets the credential at once; the hub revokes the
minted token at the forge and retries until it succeeds.

**2c. Provider-side proof, never echoing the old token**

The old value is only held by you if the grant was `supplied` (revoke it at the provider yourself,
then `fleet stations forge-api confirm-revoked ...`; agentpod cannot revoke a supplied token). For
that scratch token:

```sh
export AGENTPOD_ACCEPT_OLD_TOKEN="$(pass show forge/acceptance-scratch-pat)"   # or read -rs
./scripts/forge-api-acceptance.sh old-token-401 --url "$FORGE_URL/api/v1/user"  # prints only the status
unset AGENTPOD_ACCEPT_OLD_TOKEN
```

Expected `old-token-401: PASS` (status `401`). For a **minted** grant you cannot do this check with
the real value, because nobody holds it. Use the listing instead (C4): after revoke the grant's
token (by name and `token_last_eight`) is gone from
`GET /api/v1/users/$AGENT_LOGIN/tokens`. Record which proof was used, and which is missing.

**2d. Residue check on the station**

```sh
./scripts/forge-api-acceptance.sh --ssh "$NODE" --instance "$INST" residue "$STATION"
```

Expected after the **last** grant is revoked: no service entry for the grant in the policy file
(only shared-base copies labelled `grant: shared:<service>` may remain), zero `*.cred` files, no
file in the harness-env directory, no `90-agentpod-forge.conf` drop-in, and after a harness restart
no `HTTPS_PROXY` or token variable pointing at the broker. The instance itself (user, state, unit,
port) is expected to remain until the station is pruned (PruneUnhosted is not wired to a trigger
yet: defect D8 below). Record exactly what remains. The helper lists; you judge.

### Step 3. Reassignment

Make a fresh `read` grant first (1a), then reassign the station to a different agent:

```sh
fleet staff assign --station "$STATION" --file other-agent.json     # replaces the occupant
fleet stations forge-api list --station "$STATION"
```

Expected: the previous occupant's grant becomes `revoking` in the same change and then `revoked`
(reconcile sweep every 5 minutes, and on node reconnect); the new occupant has no grants; run
residue (2d) and C4 (no token left for the old account). Also try `fleet staff unassign`. If a
minted grant on an unoccupied station is requested, expect `409`. Record how long `revoked` took.

### Step 4. Offline-node revoke

1. Make a minted `read` grant (1a) and wait for `verified`.
2. Stop the node: `ssh "$NODE" sudo systemctl stop agentpod-node` (or `apn stop`).
3. `fleet stations forge-api revoke --station "$STATION" --grant "$GRANT"`.
4. Immediately (C4 listing) confirm the minted token is gone **at the provider** although the node
   is offline. Expected: gone at once. The wipe on the node is queued.
5. While the node is down, `residue` still shows the policy entry and credential (expected).
6. Start the node: `ssh "$NODE" sudo systemctl start agentpod-node`. Within the reconcile sweep
   (reconnect triggers it), the grant reaches `revoked` and `residue` shows no entry or credential.

Record the time from restart to `revoked`, and any grant left in `revoking`.

## 3. Cross-station isolation test

Needs two stations A and B on **one node**, with **different non-root agent uids** configured in
`forgeApi.stationUids`, each with its own instance, and a `read` grant on a scratch repo in A only.

1. Both stations create their instances (`$INST_A`, `$INST_B`; ports differ).
2. As station B's agent (its uid), in its own environment:
   - `GET` the scratch repo through B's proxy: expected `403` or `401` (no entry for that host in
     B's policy), never `200`.
   - Read A's proxy key: `cat /var/lib/$INST_A/proxy.key`, and `ls /var/lib/$INST_A`: expected
     `Permission denied`.
   - Read A's agent's environment: `cat /proc/<pid of A's harness>/environ`: expected
     `Permission denied` (distinct uids).
   - Connect to A's control socket: `stk` with `STK_SOCKET=/run/$INST_A/stk.sock`: expected refused (not
     in A's uid allowlist).
   - Use A's proxy URL directly (the port from the registry; you need A's key, which B must not be
     able to read): expected `407` without the key. Do not copy A's key into a command; if you
     test with it as the operator, prove only that B's uid cannot read it.
3. Run `stk doctor --json` as root for each instance and record `isolation.level`.
4. **Shared-uid refusal.** On a third station C mapped to the same uid as A (or unlisted, so the
   node's own uid): deliver a grant. Expected `station-uid-shared`, on deliver and on the
   status call that fetches the key; the first station on a node is never refused. Then set
   the acknowledgement and confirm: the station is served, the reply reports isolation
   `same-user` with `isolationDetail: shared-uid`, a node warning is logged, and now B (or C)
   **can** read A's `/proc/<pid>/environ` and the drop-in file, which is the documented weakness.
   Remove the acknowledgement and the extra station afterwards.

If any "expected refused" succeeds, stop and record it as a **critical** finding.

## 4. Step 5: Super Chotu files the approved Supertoolkit bug (BLOCKED)

**BLOCKED UNTIL the operator gives an explicit go-ahead.** Do not do this step because the others
passed, because it "would be quick", or because a previous conversation approved it. Constraints,
verbatim from the spec and the plan:

- "Super Chotu and the approved Supertoolkit typed-argument bug; no human or other agent's
  credential as a fallback, and the issue is not filed while building."
- "Do not file it during development and do not use any other account's credential as a fallback."
- "read it back and check title, body and author."

Prerequisites: Steps 1 to 4 and section 3 done with findings recorded; Super Chotu's station has
a wired harness path (P6: which harness Chotu runs is an open item in the spec; if it is the root
`hermes` gateway or OpenClaw's single gateway the path is **not wired** and this step must wait);
the operator's go-ahead copied into the findings table; the approved issue text in two files
(`title.txt`, `body.txt`) the operator reviewed; the repository (`SuperJackfruitLabs/supertoolkit`
or the forge path the operator names) and a `issues`-preset minted grant for Chotu limited to it.
If the grant is refused or fails, stop: do not use another account.

```sh
fleet stations forge-api grant --station "$CHOTU_STATION" --provider forgejo --instance "$FORGE_URL" \
  --repo <owner>/supertoolkit --preset issues
fleet stations forge-api verify ...                      # wait for verified (expect coverage: partial)

export AGENTPOD_ACCEPT_AGENT_SHELL='<command that opens a shell in Chotu'"'"'s brokered environment>'
export AGENTPOD_ACCEPT_EXPECT_LOGIN=<Chotu's forge login>
./scripts/forge-api-acceptance.sh --dry-run --write --yes-i-have-operator-approval file-issue "$CHOTU_STATION" \
  --repo <owner>/supertoolkit --title-file title.txt --body-file body.txt      # read the plan first
./scripts/forge-api-acceptance.sh --write --yes-i-have-operator-approval file-issue "$CHOTU_STATION" \
  --repo <owner>/supertoolkit --title-file title.txt --body-file body.txt      # types FILE IT on a terminal
```

The helper files exactly one issue, reads it back through the same broker, and compares title,
body and author (`user.login`) with what was supplied. `AGENTPOD_ACCEPT_AGENT_SHELL` is how you
reach Chotu's environment: the broker injects the credential, so nothing secret is on your machine
and there is no other credential for the helper to fall back to. Also read the issue in the forge's
UI: author is Chotu's account, not yours. After it, revoke the grant (Step 2) unless the operator
wants it kept, and run the leak check (1e) on the Chotu transcript. Whether the `AGENTPOD_ACCEPT_AGENT_SHELL`
route works for the chosen harness is UNVERIFIED; if it does not, ask the operator for a path rather than
using a different account.

## 5. Helper reference

```sh
./scripts/forge-api-acceptance.sh [--dry-run] [--ssh HOST] [--instance NAME] <subcommand> [station]
```

| Subcommand | Does | Writes? |
|---|---|---|
| `preflight` | tools present; env vars set/unset (never values) | no |
| `residue <station>` | policy service names, state dir files, credentials count, harness env files, drop-ins, unit state | no |
| `token-absence <station>` | greps `--target` / `--node-target` paths for the value in `AGENTPOD_ACCEPT_TOKEN` or `--token-fd N`; prints file names and counts only | no |
| `audit <station>` | `stk audit` rows for the instance, optional `--rule ID`, `--tail N` | no |
| `old-token-401` | one GET with the token in `AGENTPOD_ACCEPT_OLD_TOKEN`, header via curl stdin config; prints only the status | no |
| `file-issue <station>` | Step 5 only; needs `--write` AND `--yes-i-have-operator-approval` (plus typed `FILE IT` on a terminal) | one forge issue |

`--dry-run` prints each command with placeholders and runs nothing. The helper has no `set -x` and
never passes a secret in argv. Tested against stubs for curl, ssh and grep, not against a live
system.

## 6. Step 6: findings

Record in the PR description. One row per check above (C1 to C8, 1a to 1e, 2a to 2d, 3, 4, 5).

| Step | Expected | Observed | Evidence path | Issue link |
|---|---|---|---|---|
| C1 Bearer vs token | token 200, bearer 200 | | | |
| ... | | | | |

Evidence is a path to a saved file (helper output, `stk doctor --json`, `stk audit` excerpt with
no token), never a pasted secret.

### Known defects to file as issues (unless already filed)

The four SSH-grant defects (not part of this feature, found while researching):

1. Reassigning a station does not revoke the previous occupant's SSH key (`agents-admin.ts`
   never touches `station_git_identities`).
2. `grant-push` performs no reach check; any user owning the station row can grant or revoke push.
3. Audit rows drop the `username` parameter and record no actor.
4. Station deletion cascades to `station_git_identities` without revoking the key on the forge.

Defects and gaps from this feature's build:

5. The flaky credential test (the node-side credential store test that was seen to fail
   intermittently; attach the run that showed it).
6. D4. The hub does not surface `needsRestart` from deliver and revoke acks; the operator only
   learns from the node log or ack.
7. D5. Status acks lack `paths` and `wiringBlocked` (only verify carries them).
8. D6. The hub's coverage note lives in the grant's reason and is lost when a later lifecycle
   reason replaces it (coverage note persistence).
9. D7. stk `doctor --probe --exec <argv>`: the probe rig does not expose its address, so no
   harness has a safe own-client probe and every harness reports `untested`; the station's own
   client can never make `measured` complete.
10. D8. Contract `shared-uid` isolation value: acknowledged shared-uid is reported as `same-user`
    plus `isolationDetail: shared-uid` because the contract enum and the hub DB check
    constraint know only `separate-user | same-user`. Decide whether to add a third value.
11. D9. Unwired coverage: the root `hermes` gateway and OpenClaw's single gateway serve several
    stations, receive no wiring, and so cannot be brokered per station; they report
    `wired:false`.
12. The node registry is released only by `PruneUnhosted`, which is not wired to a trigger
    (needs a trusted hosted-stations list from the hub): a gone station keeps its user, unit,
    state and port.
13. The same-user write-preset acknowledgement is not asked by the hub yet (OPERATING.md 12a).

Add anything this run finds (for example `bearer` not accepted, a preset path that is too wide,
a provider that does not confine tokens by repository) with the evidence path.

## 7. What this runbook does not claim

- That any step passes. None has been run.
- That `stk audit` prints rule ids in the shape described, that C1 to C8 succeed, or that
  the helper works against a real ssh/sudo/stk. The helper is tested against stubs only.
- That the `bearer` scheme, repository-confined minted tokens, the admin token listing, the
  Hermes drop-in, or the user manager's reading of the env file work: all UNVERIFIED until C1 to C8
  are run.
- That minted tokens can be checked with their real value. They cannot (the design hides them);
  the listing and `token_last_eight` are the substitutes, and weaker.
