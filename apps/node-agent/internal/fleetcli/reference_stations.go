package fleetcli

import "github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"

// stationCommands holds the reference's entries for stations: their shape, their contents and their forge access, in page order. See Reference.
var stationCommands = []clidoc.Command{
	// ---- Stations ------------------------------------------------------------------
	{
		Path: "stations", Group: "Stations",
		Summary:  "Detect, adopt and unadopt stations; grant one push or forge API access.",
		Synopsis: "fleet stations <verb> [flags]",
		Help:     StationsUsage,
		Detail: "Acts on the fleet's shape. For one station's contents — lifecycle, disk, diffs, " +
			"files — see [`fleet station`](#fleet-station). Every verb here parses the same " +
			"flags; each lists the ones it reads.",
		Dispatch: []clidoc.Dispatch{{Func: "fleetStations", Tag: "args[0]"}},
		Exit:     "As below for each verb; with no verb, prints the usage and exits 0.",
		Example:  "fleet stations list --node node_123",
	},
	{
		Path: "stations detected", Summary: "What the node reports right now, adopted or not.",
		Synopsis: "fleet stations detected --node NODE_ID",
		Handlers: []string{"fleetStations"},
		Flags:    []clidoc.Flag{{Name: "node", Arg: "NODE_ID", Required: true}},
		Example:  "fleet stations detected --node node_123",
	},
	{
		Path: "stations list", Summary: "Adopted stations on a node, with the ids other verbs need.",
		Synopsis: "fleet stations list --node NODE_ID",
		Handlers: []string{"fleetStations"},
		Flags:    []clidoc.Flag{{Name: "node", Arg: "NODE_ID", Required: true}},
		Example:  "fleet stations list --node node_123",
	},
	{
		Path: "stations adopt", Summary: "Make detected stations into agents.",
		Synopsis: "fleet stations adopt --node NODE_ID --key KEY [--key KEY ...]",
		Detail:   "Re-detects on the node first, so a key that has gone away is not adopted from a stale list. Several keys are one reviewed call.",
		Handlers: []string{"fleetStations"},
		Flags: []clidoc.Flag{
			{Name: "node", Arg: "NODE_ID", Required: true},
			{Name: "key", Arg: "KEY", Required: true, Repeatable: true, Usage: "station key to adopt, as `fleet stations detected` reports it"},
		},
		Example: "fleet stations adopt --node node_123 --key hermes:default",
	},
	{
		Path: "stations unadopt", Summary: "Stop treating a station as an agent.",
		Synopsis: "fleet stations unadopt --station STATION_ID",
		Handlers: []string{"fleetStations"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}},
		Example:  "fleet stations unadopt --station stn_123",
	},
	{
		Path: "stations git-identity", Summary: "What a station can push to the forge as.",
		Synopsis: "fleet stations git-identity --station STATION_ID",
		Detail: "Shows the forge account, its key id, and authorName/authorEmail — who the station's " +
			"commits are by (GIT_AUTHOR_* and GIT_COMMITTER_* in its harness and terminal environment). " +
			"The author is null for an identity provisioned before authors existed, until its node next connects.",
		Handlers: []string{"fleetStations"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}},
		Example:  "fleet stations git-identity --station stn_123",
	},
	{
		Path: "stations grant-push", Summary: "Give a station a forge push key.",
		Synopsis: "fleet stations grant-push --station STATION_ID",
		Detail: "The keypair is generated on the node and the private half never leaves it; the hub " +
			"registers the public half for the station's occupying agent. Push access is never " +
			"granted by adopting a station. A hub with no forge configured answers 503.",
		Handlers: []string{"fleetStations"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}},
		Example:  "fleet stations grant-push --station stn_123",
	},
	{
		Path: "stations revoke-push", Summary: "Take a station's forge push key away.",
		Synopsis: "fleet stations revoke-push --station STATION_ID",
		Handlers: []string{"fleetStations"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}},
		Example:  "fleet stations revoke-push --station stn_123",
	},
	{
		Path: "stations forge-api", Summary: "Give a station's agent scoped forge API access through its broker (operator only).",
		Synopsis: "fleet stations forge-api <verb> --station STATION_ID [flags]",
		Help:     ForgeAPIUsage,
		Detail: "The station's broker (stk) holds the credential and injects it into requests the policy allows; the agent " +
			"never sees it. Every verb but `list` is an operator action: the hub operator seat AND the control pair's reach " +
			"over the station's agent (the owner alone is refused with 403). Three credential modes: `minted` (the hub mints a " +
			"scoped token on its configured forge for the occupying agent), `supplied` (an operator-provided token) and `app` " +
			"(a GitHub App's id, installation id and private key). A supplied or app credential is read from stdin, sealed on " +
			"this machine to the station's handover key (fetched from the hub once, before anything is created), and only the " +
			"sealed envelope is sent. There is no flag that takes a credential. Output is the hub's sanitised grant view; it " +
			"never contains a token. See [Stations](/use/stations/#forge-api-access) for the limits.",
		Dispatch: []clidoc.Dispatch{{Func: "fleetForgeAPI", Tag: "verb"}},
		Exit:     "0 on success; 2 when a flag or the stdin credential is refused before any request; 1 when the hub refuses (its status and fixed message are printed, never the request).",
		Example:  "fleet stations forge-api list --station stn_123",
	},
	{
		Path: "stations forge-api list", Summary: "A station's forge API grants: state, mode, account, isolation.",
		Synopsis: "fleet stations forge-api list --station STATION_ID [--json]",
		Detail:   "Prints only known fields (id, state, mode, account, isolation, provider, instance, preset, repositories); `--json` prints the same fields as JSON. Readable by the station's owner as well as an operator.",
		Handlers: []string{"newForgeAPIFlags"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}, {Name: "json"}},
		Example:  "fleet stations forge-api list --station stn_123",
	},
	{
		Path: "stations forge-api grant", Summary: "Grant a station API access to named repositories on one forge.",
		Synopsis: "fleet stations forge-api grant --station STATION_ID --provider forgejo|github|gitea|bitbucket \\\n" +
			"    --instance https://HOST --repo OWNER/NAME [--repo …] [--preset read|issues|pull-requests|maintain|none] \\\n" +
			"    [--rule 'allow: METHOD /path']… [--rules-file FILE] [--mode minted|app|supplied] [--expect-login LOGIN] [--allow-graphql] \\\n" +
			"    [--acknowledge-same-user]",
		Detail: "Refused before any request: no `--repo`, an `--instance` that is not https, an unknown provider, preset or mode, " +
			"a malformed `--rule`, or `--mode supplied|app` without `--expect-login` (for an app, its slug). `--rule` is " +
			"`allow: METHOD /path` or `deny: METHOD /path`; a rule with a `when` condition goes in `--rules-file`, a JSON array " +
			"of `{allow|deny, when}` objects. `minted` (the default) sends one request. `supplied` reads one token from stdin; " +
			"`app` reads `app_id=…`, `installation_id=…` and `private_key=…` lines (the PEM may continue over the following lines). " +
			"For those the CLI fetches the station's key, seals, creates the grant, then posts the envelope; if that last step " +
			"fails, re-send with `secret`. What the hub accepts today: Forgejo `minted` (the hub's configured forge only) and " +
			"`supplied`; GitHub `app` and `supplied`. Gitea and Bitbucket are refused until their adapters exist. " +
			"A write grant (any preset except `read`, or an allow rule for a write method) on a station whose broker runs in " +
			"same-user mode (today: every station) is refused (409 `same-user-acknowledgement-required`) unless the operator " +
			"passes `--acknowledge-same-user`; the hub records who acknowledged. Agents must never pass it.",
		Handlers: []string{"newForgeAPIFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "STATION_ID", Required: true},
			{Name: "provider", Arg: "PROVIDER", Required: true},
			{Name: "instance", Arg: "URL", Required: true},
			{Name: "repo", Arg: "OWNER/NAME", Required: true, Repeatable: true},
			{Name: "preset", Arg: "PRESET", Default: "read"},
			{Name: "rule", Arg: "RULE", Repeatable: true},
			{Name: "rules-file", Arg: "FILE"},
			{Name: "mode", Arg: "MODE"},
			{Name: "expect-login", Arg: "LOGIN"},
			{Name: "allow-graphql"},
			{Name: "acknowledge-same-user", Usage: "operator only: accept a write grant in same-user mode"},
		},
		Example: "fleet stations forge-api grant --station stn_123 --provider forgejo --instance https://forge.example \\\n" +
			"    --repo org/repo --preset issues\n" +
			"pbpaste | fleet stations forge-api grant --station stn_123 --provider github --instance https://github.com \\\n" +
			"    --repo org/repo --mode supplied --expect-login octo-bot",
	},
	{
		Path: "stations forge-api verify", Summary: "Re-check a grant's credential on the node.",
		Synopsis: "fleet stations forge-api verify --station STATION_ID --grant GRANT_ID",
		Handlers: []string{"newForgeAPIFlags"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}, {Name: "grant", Arg: "GRANT_ID", Required: true, Usage: "grant ID, as `fleet stations forge-api list` shows it"}},
		Example:  "fleet stations forge-api verify --station stn_123 --grant fag_123",
	},
	{
		Path: "stations forge-api rotate", Summary: "Mint a minted grant a new token; the previous one is revoked.",
		Synopsis: "fleet stations forge-api rotate --station STATION_ID --grant GRANT_ID",
		Handlers: []string{"newForgeAPIFlags"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}, {Name: "grant", Arg: "GRANT_ID", Required: true, Usage: "grant ID, as `fleet stations forge-api list` shows it"}},
		Example:  "fleet stations forge-api rotate --station stn_123 --grant fag_123",
	},
	{
		Path: "stations forge-api secret", Summary: "Re-supply a supplied or app grant's credential from stdin, sealed.",
		Synopsis: "fleet stations forge-api secret --station STATION_ID --grant GRANT_ID [--mode app]",
		Detail:   "Reads a token from stdin, or with `--mode app` the App's three field lines; fetches the station's key once, seals, and posts only the envelope.",
		Handlers: []string{"newForgeAPIFlags"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}, {Name: "grant", Arg: "GRANT_ID", Required: true, Usage: "grant ID, as `fleet stations forge-api list` shows it"}, {Name: "mode", Arg: "MODE", Usage: "app to read an App's fields instead of a token"}},
		Example:  "pbpaste | fleet stations forge-api secret --station stn_123 --grant fag_123",
	},
	{
		Path: "stations forge-api policy", Summary: "Replace a grant's preset, rules and GraphQL setting.",
		Synopsis: "fleet stations forge-api policy --station STATION_ID --grant GRANT_ID --preset PRESET [--rule RULE]… [--rules-file FILE] [--allow-graphql] [--acknowledge-same-user]",
		Detail: "Replaces, not merges: rules not given are removed, and GraphQL is off unless `--allow-graphql` is given. " +
			"Moving a same-user grant to a write policy needs `--acknowledge-same-user` (operator only).",
		Handlers: []string{"newForgeAPIFlags"},
		Flags: []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}, {Name: "grant", Arg: "GRANT_ID", Required: true, Usage: "grant ID, as `fleet stations forge-api list` shows it"},
			{Name: "preset", Arg: "PRESET", Required: true},
			{Name: "rule", Arg: "RULE", Repeatable: true},
			{Name: "rules-file", Arg: "FILE"},
			{Name: "allow-graphql"},
			{Name: "acknowledge-same-user", Usage: "operator only: accept a write policy in same-user mode"},
		},
		Example: "fleet stations forge-api policy --station stn_123 --grant fag_123 --preset issues --rule 'deny: DELETE /repos/**'",
	},
	{
		Path: "stations forge-api revoke", Summary: "Remove a grant from the station (and, when minted, revoke the token at the forge).",
		Synopsis: "fleet stations forge-api revoke --station STATION_ID --grant GRANT_ID",
		Detail:   "agentpod cannot revoke a supplied token at its provider: revoke it there, then run `confirm-revoked`.",
		Handlers: []string{"newForgeAPIFlags"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}, {Name: "grant", Arg: "GRANT_ID", Required: true, Usage: "grant ID, as `fleet stations forge-api list` shows it"}},
		Example:  "fleet stations forge-api revoke --station stn_123 --grant fag_123",
	},
	{
		Path: "stations forge-api confirm-revoked", Summary: "Record that you revoked a supplied credential at its provider.",
		Synopsis: "fleet stations forge-api confirm-revoked --station STATION_ID --grant GRANT_ID",
		Handlers: []string{"newForgeAPIFlags"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "STATION_ID", Required: true}, {Name: "grant", Arg: "GRANT_ID", Required: true, Usage: "grant ID, as `fleet stations forge-api list` shows it"}},
		Example:  "fleet stations forge-api confirm-revoked --station stn_123 --grant fag_123",
	},
	{
		Path: "station", Group: "Stations",
		Summary:  "One station: lifecycle, cleanup, changeset, files.",
		Synopsis: "fleet station <lifecycle|cleanup|changeset|fs> ...",
		Help:     StationOpsUsage,
		Detail: "The same operations as the console's panels, each gated on a capability the station " +
			"declares — see [What you can do to a station](/use/panels/). Every verb is a round " +
			"trip to the node through the hub, so an offline node answers 409. Nothing is retried: " +
			"whether a write that may have landed should be repeated is the caller's decision.",
		Dispatch: []clidoc.Dispatch{{Func: "fleetStationOps", Tag: "args[0]"}},
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet station lifecycle --station stn_123 --action restart",
	},
	{
		Path: "station lifecycle", Summary: "Start, stop or restart a station's harness.",
		Synopsis: "fleet station lifecycle --station ID --action start|stop|restart",
		Handlers: []string{"fleetStationOps", "stationFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "action", Arg: "start|stop|restart", Required: true},
		},
		Example: "fleet station lifecycle --station stn_123 --action restart",
	},
	{
		Path: "station cleanup", Summary: "Find and reclaim disk a station no longer needs.",
		Synopsis: "fleet station cleanup <plan|apply> --station ID ...",
		Dispatch: []clidoc.Dispatch{{Func: "fleetStationCleanup", Tag: "args[0]"}},
		Example:  "fleet station cleanup plan --station stn_123",
	},
	{
		Path: "station cleanup plan", Summary: "List what could be reclaimed, and how much.",
		Synopsis: "fleet station cleanup plan --station ID",
		Handlers: []string{"fleetStationCleanup", "stationFlags"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}},
		Example:  "fleet station cleanup plan --station stn_123",
	},
	{
		Path: "station cleanup apply", Summary: "Reclaim the named paths.",
		Synopsis: "fleet station cleanup apply --station ID --path P [--path P ...]",
		Detail:   "At least one `--path` is required: an empty apply is far more likely a shell glob that matched nothing than a deliberate no-op.",
		Handlers: []string{"fleetStationCleanup", "stationFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "path", Arg: "P", Required: true, Repeatable: true},
		},
		Example: "fleet station cleanup apply --station stn_123 --path .cache/pip",
	},
	{
		Path: "station changeset", Summary: "What the agent changed in the station's git checkout.",
		Synopsis: "fleet station changeset <status|diff> --station ID ...",
		Dispatch: []clidoc.Dispatch{{Func: "fleetStationChangeset", Tag: "args[0]"}},
		Example:  "fleet station changeset status --station stn_123",
	},
	{
		Path: "station changeset status", Summary: "Changed files, committed and uncommitted.",
		Synopsis: "fleet station changeset status --station ID [--base REF]",
		Handlers: []string{"fleetStationChangeset", "stationFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "base", Arg: "REF"},
		},
		Example: "fleet station changeset status --station stn_123 --base origin/main",
	},
	{
		Path: "station changeset diff", Summary: "The diff itself, one side at a time.",
		Synopsis: "fleet station changeset diff --station ID --side uncommitted|committed [--path P] [--base REF]",
		Handlers: []string{"fleetStationChangeset", "stationFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "side", Arg: "uncommitted|committed", Required: true},
			{Name: "path", Arg: "P"},
			{Name: "base", Arg: "REF"},
		},
		Example: "fleet station changeset diff --station stn_123 --side uncommitted --path README.md",
	},
	{
		Path: "station fs", Summary: "Write, create, move and delete files in a station.",
		Synopsis: "fleet station fs <write|mkdir|move|delete> --station ID ...",
		Dispatch: []clidoc.Dispatch{{Func: "fleetStationFS", Tag: "args[0]"}},
		Example:  "fleet station fs mkdir --station stn_123 --path notes",
	},
	{
		Path: "station fs write", Summary: "Write a local file (or stdin) to a path in the station.",
		Synopsis: "fleet station fs write --station ID --path P --from FILE|- [--base64] [--backup]",
		Detail:   "Sent as UTF-8 by default. A file that is not valid UTF-8 is refused rather than corrupted; send it with `--base64`.",
		Handlers: []string{"fleetStationFS", "stationFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "path", Arg: "P", Required: true},
			{Name: "from", Arg: "FILE|-", Required: true, Usage: "local file to send, or - for stdin"},
			{Name: "base64"},
			{Name: "backup"},
		},
		Example: "fleet station fs write --station stn_123 --path notes/todo.md --from todo.md\necho hello | fleet station fs write --station stn_123 --path hello.txt --from -",
	},
	{
		Path: "station fs mkdir", Summary: "Create a directory.",
		Synopsis: "fleet station fs mkdir --station ID --path P",
		Handlers: []string{"fleetStationFS", "stationFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "path", Arg: "P", Required: true},
		},
		Example: "fleet station fs mkdir --station stn_123 --path notes",
	},
	{
		Path: "station fs move", Summary: "Move or rename a path.",
		Synopsis: "fleet station fs move --station ID --from P --to P",
		Handlers: []string{"fleetStationFS", "stationFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "from", Arg: "P", Required: true, Usage: "source path on the station"},
			{Name: "to", Arg: "P", Required: true},
		},
		Example: "fleet station fs move --station stn_123 --from draft.md --to final.md",
	},
	{
		Path: "station fs delete", Summary: "Delete a file, or a directory with `--recursive`.",
		Synopsis: "fleet station fs delete --station ID --path P [--recursive]",
		Handlers: []string{"fleetStationFS", "stationFlags"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "path", Arg: "P", Required: true},
			{Name: "recursive"},
		},
		Example: "fleet station fs delete --station stn_123 --path scratch --recursive",
	},
	{
		Path: "staff", Group: "Stations",
		Summary:  "Put an agent in a station, or take it out.",
		Synopsis: "fleet staff <options|create|assign|unassign>",
		Help:     StaffUsage,
		Detail:   "Start with `options`: it says which harnesses, models and profiles this hub accepts, and every other verb here fails on a value it did not get from there.",
		Dispatch: []clidoc.Dispatch{{Func: "fleetStaff", Tag: "args[0]"}},
		Auth:     needsAdmin,
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet staff options",
	},
	{Path: "staff options", Summary: "The harnesses, models and profiles this hub accepts.", Synopsis: "fleet staff options", Example: "fleet staff options"},
	{
		Path: "staff create", Summary: "Create an agent from a definition document.",
		Synopsis: "fleet staff create --file PATH|-",
		Handlers: []string{"fleetStaff/fleet staff create"},
		Flags:    []clidoc.Flag{{Name: "file", Arg: "PATH|-", Required: true}},
		Example:  "fleet staff create --file agent.json",
	},
	{
		Path: "staff assign", Summary: "Put an agent in a station.",
		Synopsis: "fleet staff assign --station ID --file PATH|-",
		Handlers: []string{"fleetStaff/fleet staff assign"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "file", Arg: "PATH|-", Required: true},
		},
		Example: "fleet staff assign --station stn_123 --file assignment.json",
	},
	{
		Path: "staff unassign", Summary: "Take the agent out of a station.",
		Synopsis: "fleet staff unassign --station ID",
		Handlers: []string{"fleetStaff/fleet staff unassign"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}},
		Example:  "fleet staff unassign --station stn_123",
	},
	{
		Path: "config", Group: "Stations",
		Summary:  "Declare what a harness setting should be, and see what it is.",
		Synopsis: "fleet config <verb> ...",
		Help:     ConfigUsage,
		Detail: "`set` records a declaration and writes nothing to a station; `plan`, `inspect` and " +
			"`apply` are the reviewed trio that writes. See [Declared harness settings](/use/config/).",
		Dispatch: []clidoc.Dispatch{{Func: "fleetConfig", Tag: "args[0]"}},
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet config settings",
	},
	{Path: "config settings", Summary: "Every setting the fleet can declare.", Synopsis: "fleet config settings", Example: "fleet config settings"},
	{
		Path: "config show", Summary: "The declarations as stored, or one station's declared-against-observed.",
		Synopsis: "fleet config show [--node ID]\nfleet config show --station ID",
		Detail:   "Only `--station` contacts a station and reports observed values and state; without it this returns the declaration rows.",
		Handlers: []string{"fleetConfig/fleet config show"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "ID"}, {Name: "node", Arg: "ID"}},
		Example:  "fleet config show --station stn_123",
	},
	{
		Path: "config set", Summary: "Declare a setting's value, fleet-wide or for a node or station.",
		Synopsis: "fleet config set SETTING_ID --value V [--value V ...] [--station ID | --node ID]\nfleet config set SETTING_ID --json JSON [--station ID | --node ID]",
		Detail: "One `--value` declares a string; several declare a list of strings, in order. `--json` " +
			"takes any JSON value, and is the only way to declare a one-entry list, a number or a " +
			"boolean. Exactly one of them is required. With neither scope flag the declaration is " +
			"fleet-wide.",
		Args:     []clidoc.Arg{{Name: "SETTING_ID", Meaning: "a setting from `fleet config settings`"}},
		Handlers: []string{"fleetConfig/fleet config set"},
		Flags: []clidoc.Flag{
			{Name: "value", Arg: "V", Repeatable: true},
			{Name: "json", Arg: "JSON"},
			{Name: "station", Arg: "ID"},
			{Name: "node", Arg: "ID"},
		},
		Example: "fleet config set hermes.approvals.command_allowlist --value \"git status\" --value ls\nfleet config set hermes.approvals.timeout --json 900 --node node_123",
	},
	{
		Path: "config unset", Summary: "Remove a declaration at one level.",
		Synopsis: "fleet config unset SETTING_ID [--station ID | --node ID]",
		Args:     []clidoc.Arg{{Name: "SETTING_ID", Meaning: "the declared setting"}},
		Handlers: []string{"fleetConfig/fleet config unset"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "ID"}, {Name: "node", Arg: "ID"}},
		Example:  "fleet config unset hermes.approvals.timeout --node node_123",
	},
	{Path: "config drift", Summary: "Every station whose value differs from its declaration.", Synopsis: "fleet config drift", Example: "fleet config drift"},
	{
		Path: "config opt-out", Summary: "Exempt a station or node from a setting, or list exemptions.",
		Synopsis: "fleet config opt-out [--station KEY | --node ID]\nfleet config opt-out SETTING_ID (--station KEY | --node ID) [--reason TEXT]\nfleet config opt-out SETTING_ID (--station KEY | --node ID) --clear",
		Detail: "Without a SETTING_ID, lists what is exempt and where. With one, records an exemption " +
			"(exactly one of `--station` or `--node`); `--clear` forgets the row instead, so the " +
			"station falls back to its node. An exemption stops this system writing the setting; " +
			"it does not change what is already in the file.",
		Args:     []clidoc.Arg{{Name: "SETTING_ID", Meaning: "the setting to exempt; omit it to list"}},
		Handlers: []string{"fleetConfigOptOut"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "KEY"},
			{Name: "node", Arg: "ID"},
			{Name: "reason", Arg: "TEXT"},
			{Name: "clear"},
		},
		Example: "fleet config opt-out hermes.approvals.timeout --station hermes:default --reason \"tuned by hand\"",
	},
	{
		Path: "config opt-in", Summary: "Record that a station or node is not exempt, overriding its node.",
		Synopsis: "fleet config opt-in SETTING_ID (--station KEY | --node ID)",
		Detail:   "Not the same as `opt-out --clear`: this pins a station in despite a node-level exemption; a station-level row always beats a node-level one.",
		Args:     []clidoc.Arg{{Name: "SETTING_ID", Meaning: "the setting"}},
		Handlers: []string{"fleetConfig/fleet config opt-in"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "KEY"}, {Name: "node", Arg: "ID"}},
		Example:  "fleet config opt-in hermes.approvals.timeout --station hermes:default",
	},
	{
		Path: "config plan", Summary: "Derive the edit that would make a station match its declarations.",
		Synopsis: "fleet config plan --station ID [--setting SETTING_ID]",
		Detail:   "Prints the plan with its operation id and digest. Without `--setting` it plans every setting declared for the station at any level.",
		Handlers: []string{"fleetConfig/fleet config plan"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "setting", Arg: "SETTING_ID"}},
		Exit:     "As above; also 1 when nothing is declared for the station.",
		Example:  "fleet config plan --station stn_123",
	},
	{
		Path: "config inspect", Summary: "A plan already made, exactly as it was reviewed.",
		Synopsis: "fleet config inspect --station ID --operation ID",
		Handlers: []string{"fleetConfig/fleet config inspect"},
		Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "operation", Arg: "ID", Required: true}},
		Example:  "fleet config inspect --station stn_123 --operation op_123",
	},
	{
		Path: "config apply", Summary: "Write a reviewed plan to the station.",
		Synopsis: "fleet config apply --station ID --operation ID --plan-digest SHA256",
		Detail:   "Refuses to run without the digest `plan` printed, so what is written is exactly what a person reviewed, never a plan re-derived at apply time.",
		Handlers: []string{"fleetConfig/fleet config apply"},
		Flags: []clidoc.Flag{
			{Name: "station", Arg: "ID", Required: true},
			{Name: "operation", Arg: "ID", Required: true},
			{Name: "plan-digest", Arg: "SHA256", Required: true},
		},
		Example: "fleet config apply --station stn_123 --operation op_123 --plan-digest 3f2a…",
	},

	{
		Path: "mcp-proxy", Group: "Stations",
		Summary:  "Which stations each node's loopback MCP proxy serves, and their secrets.",
		Synopsis: "fleet mcp-proxy <list|enable|disable|rotate> ...",
		Help:     McpProxyUsage,
		Detail: "The proxy gives a station's harness sessions the hub's and SuperLibrary's MCP tools as " +
			"the station's own agent, through a loopback URL and a per-station secret that never leave " +
			"the node. A change is written to the node's config (`mcpProxy.stations`) and applied " +
			"without a restart; every change and rotation leaves an audit row per station. The hub " +
			"records what was **declared** here; `list` compares it with what each node **serves**. " +
			"With nothing declared, whatever the node's config says stands, so a hand-edited config " +
			"needs no migration. Needs a node at v0.1.96 or later; an older one answers `unknown`. " +
			"The node side is [`apn mcp-proxy`](/reference/apn/#apn-mcp-proxy).",
		Dispatch: []clidoc.Dispatch{{Func: "fleetMCPProxy", Tag: "args[0]"}},
		Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
		Example:  "fleet mcp-proxy list",
	},
	{
		Path: "mcp-proxy list", Summary: "Every station: eligible, declared, served, and its state.",
		Synopsis: "fleet mcp-proxy list [--node ID]",
		Detail: "`state` is `on` or `off`; `drifted` when the declaration and the node disagree (a hand edit, a " +
			"reset config); `ineffective` when a station is served but its harness takes no HTTP MCP servers; " +
			"`unknown` when the node could not be asked. `unadoptedStations` are ids the node's config names " +
			"that are not adopted stations of that node. `drifted` at the top counts all three kinds.",
		Handlers: []string{"fleetMCPProxy/fleet mcp-proxy list"},
		Flags:    []clidoc.Flag{{Name: "node", Arg: "ID"}},
		Example:  "fleet mcp-proxy list --node node_123",
	},
	{
		Path: "mcp-proxy enable", Summary: "Serve the named stations, or every eligible one.",
		Synopsis: "fleet mcp-proxy enable STATION_ID...\nfleet mcp-proxy enable --all-eligible [--node ID]",
		Detail: "Only Hermes, Claude Code, Codex, opencode, Muse and Kilo stations are eligible. Naming an OpenClaw or Pi " +
			"station refuses the whole request (422) and changes nothing: their ACP adapters take no HTTP MCP " +
			"servers in `session/new`. `--all-eligible` skips them and lists them under `skipped`. A station " +
			"already served keeps its secret, so its open sessions keep working.",
		Args:     []clidoc.Arg{{Name: "STATION_ID", Meaning: "a station id from `fleet stations`; several may be named"}},
		Handlers: []string{"fleetMCPProxy/fleet mcp-proxy enable"},
		Flags:    []clidoc.Flag{{Name: "all-eligible"}, {Name: "node", Arg: "ID"}},
		Exit:     "0 when every station is served; 1 otherwise — 404 an unknown station, 422 an ineligible one, 409 a node offline or too old, 502 a node that failed.",
		Example:  "fleet mcp-proxy enable stn_123 stn_456\nfleet mcp-proxy enable --all-eligible",
	},
	{
		Path: "mcp-proxy disable", Summary: "Stop serving the named stations.",
		Synopsis: "fleet mcp-proxy disable STATION_ID...",
		Detail:   "Applied at once: the station's next proxied request is refused, and its next session gets no proxied servers.",
		Args:     []clidoc.Arg{{Name: "STATION_ID", Meaning: "a station id; several may be named"}},
		Handlers: []string{"fleetMCPProxy/fleet mcp-proxy disable"},
		Exit:     "As `enable`.",
		Example:  "fleet mcp-proxy disable stn_123",
	},
	{
		Path: "mcp-proxy rotate", Summary: "New secrets for the named stations, or every station a node serves.",
		Synopsis: "fleet mcp-proxy rotate STATION_ID...\nfleet mcp-proxy rotate --node ID",
		Detail: "Secrets otherwise persist across node restarts, so a session kept open across one keeps " +
			"working. Rotate when that is not wanted: a session holding an old secret is refused (401) " +
			"from its next request, and new sessions get the new one. The secrets are never sent to the hub.",
		Args:     []clidoc.Arg{{Name: "STATION_ID", Meaning: "a served station's id; several may be named"}},
		Handlers: []string{"fleetMCPProxy/fleet mcp-proxy rotate"},
		Flags:    []clidoc.Flag{{Name: "node", Arg: "ID"}},
		Exit:     "As `enable`; 409 also when the node's proxy does not serve a named station.",
		Example:  "fleet mcp-proxy rotate stn_123\nfleet mcp-proxy rotate --node node_123",
	},
}
