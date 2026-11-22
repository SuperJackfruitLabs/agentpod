package fleetcli

import "github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"

// adminCommands holds the reference's entries for administration, and this binary itself, in page order. See Reference.
var adminCommands = []clidoc.Command{
	// ---- Administration ------------------------------------------------------------
	{
		Path: "settings", Group: "Administration",
		Summary:  "Hub-wide settings: signup, transcription, speech.",
		Synopsis: "fleet settings <show|signup|transcription|speech> ...",
		Help:     SettingsUsage,
		Dispatch: []clidoc.Dispatch{{Func: "fleetSettings", Tag: "args[0]"}},
		Auth:     needsAdmin,
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet settings show",
	},
	{Path: "settings show", Summary: "Every hub-wide setting.", Synopsis: "fleet settings show", Example: "fleet settings show"},
	{
		Path: "settings signup", Summary: "Whether new people may sign up (older hubs).",
		Synopsis: "fleet settings signup [enable|disable]",
		Detail:   "With no argument it reads; each direction has to be named, so a forgotten word never reopens signup. " + planeOwned,
		Dispatch: []clidoc.Dispatch{{Func: "fleetSettings", Tag: "args[1]"}},
		Exit:     "As above; 2 for any word other than enable or disable.",
		Example:  "fleet settings signup",
	},
	{Path: "settings signup enable", Summary: "Open signup (older hubs).", Synopsis: "fleet settings signup enable", Detail: planeOwned, Example: "fleet settings signup enable"},
	{Path: "settings signup disable", Summary: "Close signup (older hubs).", Synopsis: "fleet settings signup disable", Detail: planeOwned, Example: "fleet settings signup disable"},
	{
		Path: "settings transcription", Summary: "The voice-note transcription default. Bare, it shows the setting.",
		Synopsis: "fleet settings transcription [show|set --file PATH|-|test]",
		Detail:   "See [Voice notes](/use/voice/).",
		Dispatch: []clidoc.Dispatch{{Func: "settingsSubresource", Tag: "args[0]"}},
		Example:  "fleet settings transcription",
	},
	{Path: "settings transcription show", Summary: "The transcription setting.", Synopsis: "fleet settings transcription show", Example: "fleet settings transcription show"},
	{
		Path: "settings transcription set", Summary: "Replace the transcription setting with a document.",
		Synopsis: "fleet settings transcription set --file PATH|-",
		Handlers: []string{"settingsSubresource"},
		Flags:    []clidoc.Flag{{Name: "file", Arg: "PATH|-", Required: true}},
		Example:  "fleet settings transcription set --file transcription.json",
	},
	{Path: "settings transcription test", Summary: "Ask the hub to try the configured transcription service.", Synopsis: "fleet settings transcription test", Example: "fleet settings transcription test"},
	{
		Path: "settings speech", Summary: "The spoken-reply default. Bare, it shows the setting.",
		Synopsis: "fleet settings speech [show|set --file PATH|-|test]",
		Detail:   "See [Voice notes](/use/voice/).",
		Dispatch: []clidoc.Dispatch{{Func: "settingsSubresource", Tag: "args[0]"}},
		Example:  "fleet settings speech",
	},
	{Path: "settings speech show", Summary: "The speech setting.", Synopsis: "fleet settings speech show", Example: "fleet settings speech show"},
	{
		Path: "settings speech set", Summary: "Replace the speech setting with a document.",
		Synopsis: "fleet settings speech set --file PATH|-",
		Handlers: []string{"settingsSubresource"},
		Flags:    []clidoc.Flag{{Name: "file", Arg: "PATH|-", Required: true}},
		Example:  "fleet settings speech set --file speech.json",
	},
	{Path: "settings speech test", Summary: "Ask the hub to try the configured speech service.", Synopsis: "fleet settings speech test", Example: "fleet settings speech test"},
	{
		Path: "bridge", Group: "Administration",
		Summary:  "The board roster: which agent claims from which board.",
		Synopsis: "fleet bridge <list|add|set|rm|related-work|checkpoint-attempts|checkpoint-settle> ...",
		Help:     BridgeUsage,
		Detail: "This table is the gate on an agent doing anything at all: a staffed, online agent " +
			"claims no card until a row points it at a board. No verb here prints a credential. " +
			"See [Working a board](/use/boards/).",
		Dispatch: []clidoc.Dispatch{{Func: "fleetBridge", Tag: "args[0]"}},
		Auth:     needsAdmin,
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet bridge list",
	},
	{Path: "bridge list", Summary: "Every roster row.", Synopsis: "fleet bridge list", Example: "fleet bridge list"},
	{
		Path: "bridge add", Summary: "Add a roster row.",
		Synopsis: "fleet bridge add --key K --board B --station S (--token T | --credential-source station-plane)\n                 [--mcp-token M] [--mode M] [--concurrency N] [--profile P] [--wait-ms N]\n                 [--enabled true|false] [--principal P --organization O --audience A]",
		Detail: "The required flags are reported together when missing. A token row needs `--token`. " +
			"`--credential-source station-plane` adds a source row instead, with no claim token: the hub exchanges " +
			"the station occupant's own plane identity on each board request. With no `--principal`, `--organization` " +
			"or `--audience` the hub fills in all three (the station's occupant, the workspace's organization and its " +
			"own SuperPipeline origin), the only values it would admit; give all three or none. A `--token` on a source row exits 2.",
		Handlers: []string{"fleetBridge"},
		Flags: append([]clidoc.Flag{
			{Name: "key", Arg: "K", Required: true},
			{Name: "board", Arg: "B", Required: true},
			{Name: "station", Arg: "S", Required: true},
			{Name: "token", Arg: "T"},
			{Name: "credential-source", Arg: "station-plane"},
			{Name: "principal", Arg: "P"},
			{Name: "organization", Arg: "O"},
			{Name: "audience", Arg: "A"},
		}, bridgeOptional()...),
		Example: "fleet bridge add --key reviewer --board brd_123 --station stn_123 --credential-source station-plane",
	},
	{
		Path: "bridge set", Summary: "Change some fields of a roster row; the rest stay.",
		Synopsis: "fleet bridge set KEY [--board B] [--station S] [--mode M] [--enabled true|false]\n                 [--token T] [--mcp-token M] [--concurrency N] [--profile P] [--wait-ms N]\n                 [--credential-source station-plane [--principal P --organization O --audience A]]\n                 [--credential-source none --token T]",
		Detail: "Refuses a change with no fields, which the hub would otherwise answer 200 for and change nothing. " +
			"`--credential-source station-plane` gives a token row a plane credential source in place: the hub " +
			"exchanges the agent's own identity for a short-lived grant on each board request and drops the stored " +
			"claim token. A run-scoped `--mcp-token`, the harness's own board tools, is kept or can be set on the " +
			"source row. The principal must occupy the row's station (any harness) and be an agent of the workspace's organization, " +
			"and the audience must be the hub's own SuperPipeline origin (`SUPERPIPELINE_BASE_URL`); anything else " +
			"is refused; with none of `--principal`, `--organization` and `--audience` the hub fills them in. " +
			"`--credential-source none` returns the row to a token and needs `--token`.",
		Args:     []clidoc.Arg{{Name: "KEY", Meaning: "the roster key"}},
		Handlers: []string{"fleetBridge"},
		Flags: append([]clidoc.Flag{
			{Name: "board", Arg: "B"},
			{Name: "station", Arg: "S"},
			{Name: "token", Arg: "T"},
			{Name: "credential-source", Arg: "station-plane|none"},
			{Name: "principal", Arg: "P"},
			{Name: "organization", Arg: "O"},
			{Name: "audience", Arg: "A"},
		}, bridgeOptional()...),
		Example: "fleet bridge set reviewer --board brd_456",
	},
	{
		Path: "bridge rm", Summary: "Remove a roster row.", Synopsis: "fleet bridge rm KEY",
		Args: []clidoc.Arg{{Name: "KEY", Meaning: "the roster key"}}, Example: "fleet bridge rm reviewer",
	},
	{
		Path: "bridge related-work", Summary: "Switch a board's Related prior work section on or off.",
		Synopsis: "fleet bridge related-work BOARD on|off",
		Detail: "The earlier work SuperLibrary finds for a claimed card, put into the card's prompt as " +
			"reference material. On for every board until switched off; the next claim on the board " +
			"reads the new value. Anything but `on` or `off` exits 2 without calling the hub.",
		Args: []clidoc.Arg{
			{Name: "BOARD", Meaning: "a SuperPipeline `brd_` id"},
			{Name: "STATE", Meaning: "`on` or `off`"},
		},
		Handlers: []string{"fleetBridge"},
		Example:  "fleet bridge related-work brd_0000000000000001 off",
	},
	{
		Path: "bridge checkpoint-attempts", Summary: "Unresolved checkpoint attempts in this workspace.",
		Synopsis: "fleet bridge checkpoint-attempts",
		Detail: "Each attempt's phase, run and epoch; `superseded` when the installed profile has replaced the one " +
			"it was made under; `effectPossible` once a source may have been admitted. Nothing here is a credential.",
		Example: "fleet bridge checkpoint-attempts",
	},
	{
		Path: "bridge checkpoint-settle", Summary: "Settle one unresolved checkpoint attempt as retired, with evidence.",
		Synopsis: "fleet bridge checkpoint-settle ATTEMPT --evidence TEXT",
		Detail: "For an attempt the hub cannot retire by itself. Deletes nothing: the attempt ends `retired` with your " +
			"evidence beside what was already recorded, and the node is told it is no longer current. Without an " +
			"ATTEMPT, or with evidence under 20 characters, exits 2 without calling the hub.",
		Args:     []clidoc.Arg{{Name: "ATTEMPT", Meaning: "an `attempt_` id from `fleet bridge checkpoint-attempts`"}},
		Handlers: []string{"fleetBridgeCheckpointSettle"},
		Flags:    []clidoc.Flag{{Name: "evidence", Arg: "TEXT", Required: true}},
		Example:  "fleet bridge checkpoint-settle attempt_0123 --evidence \"node journal shows the record cancelled; no bench lease held\"",
	},
	{
		Path: "bench", Group: "Administration",
		Summary:  "Bench stages: a board's checkpoint work on a SuperBench host, set up from the hub.",
		Synopsis: "fleet bench <stage|doctor> ...",
		Help:     BenchUsage,
		Detail: "A stage is two records that must agree: the node's private coordinator registry profile (repositories " +
			"with their clone URLs, the worker command, the launch) and the hub's checkpoint profile (the pins every claim " +
			"is checked against). These verbs write both, in that order, and the hub's pins come from the node's own reply, " +
			"including `registry_sha256`. Nothing restarts. No reply carries a clone URL, a worker argument or a credential. " +
			"See [Registered bench launch](https://github.com/SuperJackfruitLabs/agentpod/blob/main/docs/BENCH_REGISTERED_LAUNCH.md).",
		Dispatch: []clidoc.Dispatch{{Func: "fleetBench", Tag: "args[0]"}},
		Auth:     needsAdmin,
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet bench stage list",
	},
	{
		Path: "bench stage", Summary: "Add, change, list or remove a bench stage.",
		Synopsis: "fleet bench stage <list|add|set|rm> ...",
		Dispatch: []clidoc.Dispatch{{Func: "fleetBenchStage", Tag: "verb"}},
		Example:  "fleet bench stage list",
	},
	{
		Path: "bench stage list", Summary: "Every stage in the workspace, and whether its node serves it as pinned.",
		Synopsis: "fleet bench stage list",
		Detail: "Each stage's `served` is `served` (the node advertises exactly the pinned target), `drifted` (with the " +
			"fields that differ), `missing`, or `unknown` (the node could not be asked). A profile still loaded from the " +
			"legacy profile file shows `origin: file-only`.",
		Example: "fleet bench stage list",
	},
	{
		Path: "bench stage add", Summary: "Set up one stage: roster row, node registry profile and hub profile.",
		Synopsis: "fleet bench stage add NAME --board B --station S --agent agt_… --checkpoint-repo N\n" +
			"                     --repo name=N,provider=P,repository=OWNER/REPO,clone=URL[,base=B][,format=F] ...\n" +
			"                     --worker PATH [--worker-arg A ...] [--env K=V ...] [--launch registered-v1|grouped]\n" +
			"                     [--source-tenant tnt_…] [--stage-id ID] [--bridge-key K] [--repin] [--keep-bench]",
		Detail: "In order, each step idempotent and each refusal naming the step: the station's roster row for the board " +
			"(created as a `station-plane` source row, or upgraded to one); the node's registry profile (written atomically " +
			"and reloaded; a refused change writes nothing); the hub's checkpoint profile, built from the station, the roster, " +
			"the hub's own service grant (the reporter) and the node's reply. Other stages on the same node are re-pinned to " +
			"the node's new digest in the same write. `--repo` is the stage's allow-list: a claim's policy names exactly these " +
			"repositories. The reply prints the stage's `checkpointPolicy` for SuperPipeline and the steps still manual. " +
			"`--source-tenant` is needed only for the workspace's first stage. Missing required flags are named together and exit 2.",
		Args:     []clidoc.Arg{{Name: "NAME", Meaning: "the stage's name: the node registry profile id and the coordinator profile id"}},
		Handlers: []string{"fleetBenchStage"},
		Flags: []clidoc.Flag{
			{Name: "board", Arg: "B", Required: true},
			{Name: "station", Arg: "S", Required: true},
			{Name: "agent", Arg: "agt_…", Required: true},
			{Name: "checkpoint-repo", Arg: "N", Required: true},
			{Name: "repo", Arg: "SPEC", Required: true, Repeatable: true},
			{Name: "worker", Arg: "PATH", Required: true},
			{Name: "worker-arg", Arg: "A", Repeatable: true},
			{Name: "env", Arg: "K=V", Repeatable: true},
			{Name: "launch", Arg: "L"},
			{Name: "source-tenant", Arg: "tnt_…"},
			{Name: "stage-id", Arg: "ID"},
			{Name: "bridge-key", Arg: "K"},
			{Name: "repin"},
			{Name: "keep-bench"},
		},
		Example: "fleet bench stage add review --board brd_0123456789abcdef --station stn_123 --agent agt_abc123 \\\n" +
			"  --repo name=app,provider=forge,repository=example/app,clone=ssh://git@forge.example:2222/example/app.git,base=main \\\n" +
			"  --checkpoint-repo app --worker /usr/local/libexec/bench-harness --source-tenant tnt_0123456789abcdef",
	},
	{
		Path: "bench stage set", Summary: "Change one stage; the hub's pins and the node's target are re-derived.",
		Synopsis: "fleet bench stage set NAME [--board B] [--station S] [--agent agt_…] [--checkpoint-repo N] [--repo SPEC ...]\n" +
			"                     [--worker PATH [--worker-arg A ...] [--env K=V ...] [--launch L]]\n" +
			"                     [--source-tenant tnt_…] [--stage-id ID] [--repin] [--refresh] [--keep-bench[=false]]",
		Detail: "Fields not given keep their value on the node and in the hub. `--board` moves the stage and its roster row to " +
			"another board in one write. `--repo` replaces the whole allow-list. `--repin` re-pins the node's worker and " +
			"coordinator digests after an update; `--refresh` re-derives the hub's pins (occupant, owner, occupancy epoch, " +
			"roster profile, reporter) and changes nothing else. A stage moved to a station on another node needs its " +
			"`--repo` list and `--worker` again. An attempt already running keeps its retained authority and is retired by " +
			"the existing stale-owner path. Also takes over a stage still loaded from the legacy profile file. " +
			"Once a card's checkpoint settles, the hub reclaims its bench (its tree and quota) so the host does not fill; " +
			"a card that comes back gets a fresh bench from its card branch. `--keep-bench` keeps settled benches for " +
			"this stage instead, and `--keep-bench=false` returns to the default.",
		Args:     []clidoc.Arg{{Name: "NAME", Meaning: "the stage's name"}},
		Handlers: []string{"fleetBenchStage"},
		Flags: []clidoc.Flag{
			{Name: "board", Arg: "B"},
			{Name: "station", Arg: "S"},
			{Name: "agent", Arg: "agt_…"},
			{Name: "checkpoint-repo", Arg: "N"},
			{Name: "repo", Arg: "SPEC", Repeatable: true},
			{Name: "worker", Arg: "PATH"},
			{Name: "repin"},
			{Name: "refresh"},
			{Name: "keep-bench"},
		},
		Example: "fleet bench stage set review --board brd_fedcba9876543210",
	},
	{
		Path: "bench stage rm", Summary: "Remove a stage from its node's registry and from the hub.",
		Synopsis: "fleet bench stage rm NAME",
		Detail:   "The roster row is kept (`fleet bridge rm KEY` removes it). A node that no longer has the profile is not an error.",
		Args:     []clidoc.Arg{{Name: "NAME", Meaning: "the stage's name"}},
		Example:  "fleet bench stage rm review",
	},
	{
		Path: "bench doctor", Summary: "Check everything a stage needs before its first card.",
		Synopsis: "fleet bench doctor NAME | --station S [--json]",
		Detail: "One PASS or FAIL line per check, each failure with its next step: this hub's coordinator flag, control pair " +
			"and SuperPipeline audience; the station's occupant and node; the node's registry (configured, valid), benchd " +
			"(reachable, managed, free space on its data and state volumes), the worker's and node's pinned digests against " +
			"the installed bytes; the roster row, its credential source, a trial exchange of the agent's grant (`claim` and " +
			"`run`), the run-only MCP token and the owner's dispatch grant; the hub's service grant (`checkpoints:submit` and " +
			"`checkpoints:read`); and, for a stage, the hub's pins, the node's served target and its SuperPipeline stage id. " +
			"A stage with no stage id (one adopted from the profile file) is a WARN line naming `--stage-id`, not a failure. " +
			"Then the steps no verb takes (Accounts and SuperPipeline) and the stage's `checkpointPolicy`. Changes nothing. " +
			"Exits 1 when a check failed.",
		Args:     []clidoc.Arg{{Name: "NAME", Meaning: "a stage name; or give --station for a station with no stage yet"}},
		Handlers: []string{"fleetBenchDoctor"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "S"}, {Name: "json"}},
		Exit:     "0 when every check passed, 1 when one failed, 2 for a usage error.",
		Example:  "fleet bench doctor review",
	},
	{
		Path: "principals", Group: "Administration",
		Summary:  "Identities, service principals and their credentials.",
		Synopsis: "fleet principals <verb> ...",
		Help:     PrincipalsUsage,
		Detail:   "Only `list` works against a current hub; the rest are managed by the account service.",
		Dispatch: []clidoc.Dispatch{{Func: "fleetPrincipals", Tag: "args[0]"}},
		Auth:     needsAdmin,
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet principals list",
	},
	{Path: "principals list", Summary: "Who exists in this workspace, read through the account service.", Synopsis: "fleet principals list", Example: "fleet principals list"},
	{
		Path: "principals suspend", Summary: "Suspend a principal, reversibly (older hubs).", Synopsis: "fleet principals suspend ID",
		Detail: planeOwned, Args: []clidoc.Arg{{Name: "ID", Meaning: "a `prn_` id"}}, Example: "fleet principals suspend prn_123",
	},
	{
		Path: "principals restore", Summary: "Undo a suspension (older hubs).", Synopsis: "fleet principals restore ID",
		Detail: planeOwned, Args: []clidoc.Arg{{Name: "ID", Meaning: "a `prn_` id"}}, Example: "fleet principals restore prn_123",
	},
	{
		Path: "principals add-service", Summary: "Create a service principal with its first credential (older hubs).",
		Synopsis: "fleet principals add-service HANDLE --client CLIENT --scope SCOPE[,SCOPE]",
		Detail:   "The response carries the credential's secret once; it cannot be read again. " + planeOwned,
		Args:     []clidoc.Arg{{Name: "HANDLE", Meaning: "the service's handle"}},
		Handlers: []string{"fleetPrincipals/fleet principals add-service"},
		Flags: []clidoc.Flag{
			{Name: "client", Arg: "CLIENT", Required: true},
			{Name: "scope", Arg: "SCOPE[,SCOPE]", Required: true},
		},
		Example: "fleet principals add-service evidence-reader --client superwitness --scope evidence:read",
	},
	{
		Path: "principals add-credential", Summary: "Add a credential to a service principal: the first half of a rotation (older hubs).",
		Synopsis: "fleet principals add-credential PRN_ID --client CLIENT",
		Detail:   "The old credential keeps working until `revoke-credential`, so the consumer can switch with no gap. " + planeOwned,
		Args:     []clidoc.Arg{{Name: "PRN_ID", Meaning: "the service principal's id"}},
		Handlers: []string{"fleetPrincipals/fleet principals add-credential"},
		Flags:    []clidoc.Flag{{Name: "client", Arg: "CLIENT", Required: true}},
		Example:  "fleet principals add-credential prn_123 --client superwitness",
	},
	{
		Path: "principals revoke-credential", Summary: "Revoke one service credential (older hubs).",
		Synopsis: "fleet principals revoke-credential SVC_ID",
		Detail:   planeOwned,
		Args:     []clidoc.Arg{{Name: "SVC_ID", Meaning: "the credential's `svc_` id"}},
		Example:  "fleet principals revoke-credential svc_123",
	},
	{
		Path: "grants", Group: "Administration",
		Summary:  "Dispatch authority, as a document (older hubs).",
		Synopsis: "fleet grants <list|show|set|rm> ...",
		Help:     GrantsUsage,
		Detail:   planeOwned + " See [Dispatch and grants](/use/grants/).",
		Dispatch: []clidoc.Dispatch{{Func: "fleetGrants", Tag: "args[0]"}},
		Auth:     needsAdmin,
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet grants list",
	},
	{Path: "grants list", Summary: "Every grant.", Synopsis: "fleet grants list", Detail: planeOwned, Example: "fleet grants list"},
	{
		Path: "grants show", Summary: "One principal's grant.", Synopsis: "fleet grants show PRINCIPAL_ID",
		Detail: planeOwned, Args: []clidoc.Arg{{Name: "PRINCIPAL_ID", Meaning: "a `prn_` id"}}, Example: "fleet grants show prn_123",
	},
	{
		Path: "grants set", Summary: "Replace a principal's grant with a document.",
		Synopsis: "fleet grants set PRINCIPAL_ID --file PATH|-",
		Detail:   planeOwned,
		Args:     []clidoc.Arg{{Name: "PRINCIPAL_ID", Meaning: "a `prn_` id"}},
		Handlers: []string{"fleetGrants"},
		Flags:    []clidoc.Flag{{Name: "file", Arg: "PATH|-", Required: true}},
		Example:  "fleet grants set prn_123 --file grant.json",
	},
	{
		Path: "grants rm", Summary: "Remove a principal's grant.", Synopsis: "fleet grants rm PRINCIPAL_ID",
		Detail: planeOwned, Args: []clidoc.Arg{{Name: "PRINCIPAL_ID", Meaning: "a `prn_` id"}}, Example: "fleet grants rm prn_123",
	},
	{
		Path: "users", Group: "Administration",
		Summary:  "People: list, show, ban, unban, role (older hubs).",
		Synopsis: "fleet users <list|show|ban|unban|role> ...",
		Help:     UsersUsage,
		Detail:   planeOwned,
		Dispatch: []clidoc.Dispatch{{Func: "fleetUsers", Tag: "args[0]"}},
		Auth:     needsAdmin,
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet users list",
	},
	{Path: "users list", Summary: "Every account.", Synopsis: "fleet users list", Detail: planeOwned, Example: "fleet users list"},
	{
		Path: "users show", Summary: "One account.", Synopsis: "fleet users show ID",
		Detail: planeOwned, Args: []clidoc.Arg{{Name: "ID", Meaning: "the user's id"}}, Example: "fleet users show usr_123",
	},
	{
		Path: "users ban", Summary: "Ban an account, with a recorded reason.",
		Synopsis: "fleet users ban ID --reason \"why\" [--expires RFC3339]",
		Detail:   "A reason is required: a ban nobody can review later is one the next person cannot lift with confidence. " + planeOwned,
		Args:     []clidoc.Arg{{Name: "ID", Meaning: "the user's id"}},
		Handlers: []string{"fleetUsers/fleet users ban"},
		Flags: []clidoc.Flag{
			{Name: "reason", Arg: "TEXT", Required: true},
			{Name: "expires", Arg: "RFC3339"},
		},
		Example: "fleet users ban usr_123 --reason \"shared credentials\" --expires 2026-12-01T00:00:00Z",
	},
	{
		Path: "users unban", Summary: "Lift a ban.", Synopsis: "fleet users unban ID",
		Detail: planeOwned, Args: []clidoc.Arg{{Name: "ID", Meaning: "the user's id"}}, Example: "fleet users unban usr_123",
	},
	{
		Path: "users role", Summary: "Set an account's role.", Synopsis: "fleet users role ID --role ROLE",
		Detail:   planeOwned,
		Args:     []clidoc.Arg{{Name: "ID", Meaning: "the user's id"}},
		Handlers: []string{"fleetUsers/fleet users role"},
		Flags:    []clidoc.Flag{{Name: "role", Arg: "ROLE", Required: true}},
		Example:  "fleet users role usr_123 --role admin",
	},

	// ---- This binary ---------------------------------------------------------------
	{
		Path: "update", Group: "This binary",
		Summary:  "Replace this binary with the newest release.",
		Synopsis: "fleet update [--check] [--force]",
		Detail:   "Fetches the `agentpod-fleet` asset for this platform and verifies it against the release's `SHA256SUMS`. There is no service to restart: the next invocation is the new binary.",
		Handlers: []string{"fleetUpdate"},
		Flags:    []clidoc.Flag{{Name: "check"}, {Name: "force"}},
		Auth:     "Nothing from the hub. Network access to GitHub releases, and write access to the binary's own path.",
		Exit:     "0 when up to date, updated, or (with `--check`) reported. 1 when the release could not be fetched or verified.",
		Example:  "fleet update --check\nfleet update",
	},
	{
		Path: "skill", Group: "This binary",
		Summary:  "Print the skill that ships inside this binary.",
		Synopsis: "fleet skill\nfleet skill install [--dir DIR] [--json]",
		Detail: "Prints a `SKILL.md` for agents: what `fleet` is, how to sign in, every verb, and which verbs " +
			"change shared state and so need an operator's say-so. It is written from this binary's own " +
			"verbs and stamped with its version, and a test fails when a verb exists that it does not " +
			"mention. Not to be confused with `fleet skills`, which manages skill artifacts on the fleet.",
		Dispatch: []clidoc.Dispatch{{Func: "fleetSkill", Tag: "args[0]"}},
		Auth:     needsNone,
		Exit:     "0. 2 for an unknown subverb.",
		Example:  "fleet skill | less",
	},
	{
		Path:     "skill install",
		Summary:  "Write the skill where an agent will find it.",
		Synopsis: "fleet skill install [--dir DIR] [--json]",
		Detail: "Writes `DIR/agentpod-fleet/SKILL.md` atomically (a staged file in the same directory, then a " +
			"rename) and prints the path. Running it again rewrites only that file. `DIR` defaults to " +
			"`~/.claude/skills`. `fleet update` refreshes a copy at the default directory and never creates one.",
		Handlers: []string{"fleetSkillInstall"},
		Flags:    []clidoc.Flag{{Name: "dir", Arg: "DIR"}, {Name: "json"}},
		Auth:     needsNone,
		Exit:     "0 once written. 1 when the file could not be written. 2 for a bad flag.",
		Example:  "fleet skill install\nfleet skill install --dir ./skills --json",
	},
	{
		Path: "version", Group: "This binary",
		Summary:  "Print the version and platform.",
		Synopsis: "fleet version",
		Auth:     needsNone,
		Exit:     "0.",
		Example:  "fleet version   # agentpod-fleet v0.1.90 darwin/arm64",
	},
	{
		Path: "help", Group: "This binary",
		Summary:  "Print the verb list and how credentials work.",
		Synopsis: "fleet help\nfleet -h\nfleet",
		Detail:   "All three print the same text. A group's own usage is `fleet <verb> -h`; for verbs with flags, `fleet <verb> <subverb> -h` prints them with their defaults.",
		Auth:     needsNone,
		Exit:     "0.",
		Example:  "fleet help",
	},
}
