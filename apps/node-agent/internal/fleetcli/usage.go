package fleetcli

const GrantsUsage = `usage:
  fleet grants list
  fleet grants show PRINCIPAL_ID
  fleet grants set PRINCIPAL_ID --file PATH|-
  fleet grants rm PRINCIPAL_ID`

const PrincipalsUsage = `usage:
  fleet principals list
  fleet principals suspend ID
  fleet principals restore ID
  fleet principals add-service HANDLE --client CLIENT --scope SCOPE[,SCOPE]
  fleet principals add-credential PRN_ID --client CLIENT
  fleet principals revoke-credential SVC_ID`

const UsersUsage = `usage:
  fleet users list
  fleet users show ID
  fleet users ban ID --reason "why" [--expires RFC3339]
  fleet users unban ID
  fleet users role ID --role ROLE`

const BridgeUsage = `usage:
  fleet bridge list
  fleet bridge add --key K --board B --station S --token T [--mcp-token M]
                   [--mode M] [--concurrency N] [--profile P] [--wait-ms N] [--enabled true|false]
  fleet bridge set KEY [--board B] [--station S] [--mode M] [--enabled true|false]
                   [--token T] [--mcp-token M] [--concurrency N] [--profile P] [--wait-ms N]
  fleet bridge rm KEY
  fleet bridge related-work BOARD on|off`

const ConfigUsage = `usage:
  fleet config settings                                         every setting the fleet can declare
  fleet config show   [--node ID]                               the declarations themselves, as stored
  fleet config show   --station ID                              one station: declared vs observed, with state
  fleet config set    SETTING_ID --value V [--value V ...] [--station ID | --node ID]
  fleet config set    SETTING_ID --json  JSON          [--station ID | --node ID]
  fleet config unset  SETTING_ID [--station ID | --node ID]
  fleet config drift                                            every station whose value differs
  fleet config opt-out SETTING_ID [--station KEY | --node ID] [--reason TEXT]
  fleet config opt-in  SETTING_ID [--station KEY | --node ID]
  fleet config opt-out SETTING_ID [--station KEY | --node ID] --clear
  fleet config opt-out                                          what is exempt, and where
  fleet config plan    --station ID [--setting SETTING_ID]      narrow the plan to one setting
  fleet config inspect --station ID --operation ID              a plan already made, as it was reviewed
  fleet config apply   --station ID --operation ID --plan-digest SHA256

` + "`set` records a DECLARATION; it does not write to a station. `apply` is the\n" +
	"verb that writes, and it refuses to run without --plan-digest: that digest\n" +
	"must be the one `plan` printed for this operation, so a human reviewed the\n" +
	"exact edit being written rather than whatever the current plan happens to\n" +
	"be by the time apply runs.\n\n" +
	"Only `show --station` and `drift` compare anything. Without --station, `show`\n" +
	"returns the declaration rows and contacts no station: no observed value, no\n" +
	"state. A fleet- or node-level declaration is one row that may apply to many\n" +
	"stations, so comparing it means naming which station you mean.\n\n" +
	"--station is accepted for any setting. A setting whose registered scope is\n" +
	"not `profile` is NOT refused here; it is stored, and reported `out-of-scope`\n" +
	"when the declaration is read back.\n\n" +
	"A single --value is always declared as a STRING. A setting whose value is a\n" +
	"list — every `additive-only` setting is one, a command allowlist being the\n" +
	"first — is declared either by repeating --value once per entry:\n\n" +
	"  fleet config set hermes.approvals.command_allowlist \\\n" +
	"      --value \"git status\" --value \"ls\"\n\n" +
	"or with --json, which takes the value exactly as JSON and is the way to\n" +
	"declare a ONE-entry list, a number or a boolean:\n\n" +
	"  fleet config set hermes.approvals.command_allowlist --json '[\"git status\"]'\n" +
	"  fleet config set hermes.approvals.timeout --json 900\n\n" +
	"--value and --json are mutually exclusive, and `set` needs one of them: a\n" +
	"declaration with no value is not a declaration. A list-valued setting given\n" +
	"a single --value is stored as the string it is, and every later plan for that\n" +
	"station is refused SHAPE_UNEXPECTED by the node, so the shape matters here\n" +
	"rather than at write time.\n\n" +
	"`opt-out` stops this system writing a setting; it does not change what is already in the file.\n" +
	"An exemption is not an undo — a station that was already drifted, or\n" +
	"already carries a value written before the exemption existed, stays\n" +
	"exactly as it is.\n\n" +
	"`opt-in` is not the same as `--clear`. `opt-in` records \"this station is\n" +
	"NOT exempt\", which overrides a node-level exemption for that one station.\n" +
	"`--clear` forgets the exemption row entirely, so the station falls back to\n" +
	"whatever the node says — if the node is exempt, the station is exempt\n" +
	"again too. Use `opt-in` to pin a station in despite its node; use --clear\n" +
	"to stop having an opinion at the station level at all.\n\n" +
	"A station-level row always beats a node-level one — `opt-in` at the\n" +
	"station overrides `opt-out` at the node, never the other way around.\n\n" +
	"--station names a station by its stationKey, not its row id: a stationKey\n" +
	"survives unadopt and re-adopt, so an exemption recorded against it still\n" +
	"applies after the station is re-adopted, which a row id would not."

const ForgeAPIUsage = `Usage: fleet stations forge-api <verb> --station STATION_ID [flags]

  list            --station ID                       grants: state, mode, account, isolation
  grant           --station ID --provider P --instance https://… --repo owner/name …
                  [--preset read|issues|pull-requests|maintain|none]
                  [--rule 'allow: METHOD /path']… [--rules-file FILE]
                  [--mode minted|app|supplied] [--expect-login LOGIN] [--allow-graphql]
                  [--acknowledge-same-user]
  verify          --station ID --grant GRANT_ID      re-check the credential on the node
  rotate          --station ID --grant GRANT_ID      minted: a new token, the old one revoked
  secret          --station ID --grant GRANT_ID      re-supply a credential (stdin); add --mode app for an App
  policy          --station ID --grant GRANT_ID --preset P [--rule …]… [--rules-file FILE] [--allow-graphql]
                  [--acknowledge-same-user]
                  replaces the whole policy: omitting --allow-graphql turns GraphQL OFF
  revoke          --station ID --grant GRANT_ID
  confirm-revoked --station ID --grant GRANT_ID      supplied: you revoked it at the provider

Granting an agent forge API access is an OPERATOR action (hub operator seat and the
control pair's reach). An agent must not try to grant itself access.

A supplied or app credential is read from STDIN, never from a flag: a token for
--mode supplied; for --mode app the lines app_id=…, installation_id=… and
private_key=… (the PEM may continue over the following lines). The CLI fetches
the station's handover key and seals the credential to it on this machine; the
hub only ever sees the sealed envelope. A minted grant needs no credential.

A write grant (any preset except read, or an allow rule for a write method) on a
station whose broker runs in same-user mode is refused until the operator passes
--acknowledge-same-user: the agent could then read the broker's store. Today every
station reports same-user. The hub records who acknowledged.`

const InviteUsage = `usage:
  fleet invite [--label TEXT] [--ttl-minutes N]`

const McpProxyUsage = `usage:
  fleet mcp-proxy list [--node ID]                            every station: declared, served, state
  fleet mcp-proxy enable STATION_ID...                        serve these stations
  fleet mcp-proxy enable --all-eligible [--node ID]           serve every station whose harness can use it
  fleet mcp-proxy disable STATION_ID...                       stop serving these stations
  fleet mcp-proxy rotate STATION_ID... | --node ID            new secrets; sessions holding old ones are refused

The node's loopback MCP proxy gives a station's harness sessions the hub's and
SuperLibrary's MCP tools, as the station's own agent. Only Hermes, Claude Code,
Codex, opencode, Muse and Kilo stations can use it: OpenClaw's and Pi's ACP adapters take
no HTTP MCP servers in session/new, and enabling one is refused.

A change is written to the node's config and applied without a restart, and
leaves an audit row per station. A state of "drifted" means what was declared
here and what the node serves disagree — re-run enable or disable to settle it.
Secrets never leave the node.`

const NodesUsage = `Usage: fleet nodes [update|telemetry|rm]

  fleet nodes                               the fleet's nodes, with versions
  fleet nodes update [--node NAME|ID …] [--force]
  fleet nodes rm NAME|ID [--force]          remove a retired machine from the fleet
  fleet nodes telemetry                     each node's OpenTelemetry setting
  fleet nodes telemetry [--node NAME|ID …] --endpoint <url> | --off

update asks the hub to roll the newest release to your nodes, one at a time,
and prints what happened to each. With --node it touches only those nodes
(repeatable; a name or an ID from ` + "`fleet nodes`" + `). --force re-applies the current
release to a node that already has it — the escape hatch for a corrupt binary.

rm removes an enrolled node: its stations are unregistered and its credential is
revoked, so the machine cannot reconnect; to rejoin it needs a fresh
` + "`fleet invite`" + ` token. A connected node is refused unless --force, which
disconnects it. A provisioned runtime's node is removed with ` + "`fleet runtimes rm`" + `.

Only the node-agent restarts; the harnesses it serves keep running. The exit
status is 1 if any node was asked and did not update.

telemetry (admin role required) reads or sets the OTLP endpoint each node-agent
exports traces to, with no SSH. Without flags it lists the setting per node
(offline nodes are shown and do not fail the exit status). --endpoint takes an
http or https URL; --off disables export. A node restarts itself only if its
setting changed. A node too old to know the verb says "unsupported" until
` + "`fleet nodes update`" + `. The exit status is 1 if any node failed, was
unsupported, or (when setting) was offline and so did not apply the change.`

const NodesTelemetryUsage = `Usage: fleet nodes telemetry [--node NAME|ID …] [--endpoint <url> | --off]

With no flags, lists each node's telemetry setting. With --endpoint <url> (http
or https) or --off, sets it on every node, or only the --node ones. Admin role
required. Exit 1 if any node failed, was unsupported, or (when setting) offline.`

const NodesRmUsage = `Usage: fleet nodes rm NAME|ID [--force]

Removes an enrolled node from the fleet. Its stations are unregistered (as
` + "`fleet stations unadopt`" + ` would), and its credential is revoked, so the machine
cannot reconnect; to rejoin it must be enrolled again with a fresh
` + "`fleet invite`" + ` token. Workspace files on the machine are not touched, and the
node-agent keeps running until it is uninstalled there.

A connected node is refused unless --force, which disconnects it. A provisioned
runtime's node is refused: ` + "`fleet runtimes rm`" + ` removes the runtime and its node.`

const PluginsUsage = `usage:
  fleet plugins plan --station ID --action enable|disable
  fleet plugins show --station ID --operation ID
  fleet plugins inspect --station ID --operation ID
  fleet plugins apply --station ID --operation ID --plan-digest SHA256
  fleet plugins history --station ID
  fleet plugins inventory --station ID`

const RuntimesUsage = `usage:
  fleet runtimes list
  fleet runtimes providers
  fleet runtimes create --file PATH|-
  fleet runtimes start ID
  fleet runtimes stop ID
  fleet runtimes rm ID`

// fleet skills — the operator CLI for the same reviewed catalog and canary
// protocol exposed by the Console.  It deliberately prints the hub's complete
// JSON replies: plans and receipts are review evidence, not data to summarize
// away in a convenience client.

const SkillsUsage = `Usage: fleet skills <verb>

  fleet skills artifacts
  fleet skills artifact delete --id ARTIFACT_ID
  fleet skills releases
  fleet skills cohorts
  fleet skills upload --harness H --profile P ARCHIVE.tgz
  fleet skills release import RELEASE.json
  fleet skills cohort create --release ID --digest SHA256 --station ID
  fleet skills canary plan --cohort ID --release ID --digest SHA256 --station ID
  fleet skills canary inspect --cohort ID --release ID --digest SHA256 --station ID --operation ID
  fleet skills canary apply --cohort ID --release ID --digest SHA256 --station ID --operation ID --plan-digest SHA256
  fleet skills station plan --station ID --artifact ARTIFACT_ID
  fleet skills station verify --station ID --profile PROFILE
  fleet skills station rollback-plan --station ID --profile PROFILE
  fleet skills station inspect --station ID --operation ID
  fleet skills station apply --station ID --operation ID --plan-digest SHA256
  fleet skills native plan --station ID --profile PROFILE --action activate|deactivate|rollback
  fleet skills native inspect --station ID --operation ID
  fleet skills native apply --station ID --operation ID --plan-digest SHA256
  fleet skills native verify --station ID --profile PROFILE

Every mutation returns the hub's reviewed record. Read that response before an
apply command; this CLI never turns a plan into an implicit apply.`

const StaffUsage = `usage:
  fleet staff options
  fleet staff create --file PATH|-
  fleet staff assign --station ID --file PATH|-
  fleet staff unassign --station ID`

const SettingsUsage = `usage:
  fleet settings show
  fleet settings signup [enable|disable]
  fleet settings transcription [show|set --file PATH|- |test]
  fleet settings speech [show|set --file PATH|- |test]`

const StationOpsUsage = `usage:
  fleet station lifecycle --station ID --action start|stop|restart
  fleet station cleanup plan --station ID
  fleet station cleanup apply --station ID --path P [--path P …]
  fleet station changeset status --station ID [--base REF]
  fleet station changeset diff --station ID --side uncommitted|committed [--path P] [--base REF]
  fleet station fs write  --station ID --path P --from FILE|- [--base64] [--backup]
  fleet station fs mkdir  --station ID --path P
  fleet station fs move   --station ID --from P --to P
  fleet station fs delete --station ID --path P [--recursive]`

const StationsUsage = `Usage: fleet stations <verb>

  fleet stations detected --node NODE_ID     what the node reports right now
  fleet stations list --node NODE_ID         adopted stations, with their IDs
  fleet stations adopt --node NODE_ID --key KEY [--key KEY …]
  fleet stations unadopt --station STATION_ID

  fleet stations git-identity --station STATION_ID   what it can push to forge as
  fleet stations grant-push   --station STATION_ID   give it a forge push key
  fleet stations revoke-push  --station STATION_ID   take that key away

  fleet stations forge-api <verb> --station STATION_ID …   forge API access through the
                                                     station's broker (operator only;
                                                     see fleet stations forge-api --help)

A detected station is not an agent until it is adopted. Adopting re-detects on
the node first, so a key that has gone away is not adopted from a stale list.

Push access is granted per station and never by adopting one: most stations
never touch git, and a forge key for every station is an account nobody uses
and a key nobody revokes. The keypair is generated ON THE NODE and the private
half never leaves it — grant-push asks for the public half and registers that.`
