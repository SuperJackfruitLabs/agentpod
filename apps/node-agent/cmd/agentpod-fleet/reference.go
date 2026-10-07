package main

import "github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"

// The command reference: every verb and subverb this binary dispatches, rendered into
// docs-site/src/content/docs/reference/fleet.md and into `fleet help`'s verb list.
//
// reference_test.go checks it against the source in both directions — a verb dispatched with no
// entry, an entry nothing dispatches, a flag declared and documented nowhere, a documented flag
// nothing declares, an environment variable read and not listed — and fails when the committed
// page is not what this table renders. Flag types, defaults and meanings come from the FlagSet
// declarations themselves; improve a flag's description there, where `-h` shows it too.

// Requirements, named once.
const (
	needsHuman = "A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. " +
		"The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns."
	needsAdmin = "A workspace admin's token. Anyone else is refused with 403."
	needsNone  = "Nothing. Runs without a credential or a hub."

	// The records the account service owns on a current hub. Left in the binary for hubs that
	// predate it; documented as what they do today, which is refuse.
	planeOwned = "On a hub that signs in through an account service (every current hub), this " +
		"record is managed there: the hub answers 410 `managed_by_org_plane` with the account " +
		"service's URL, which this prints, and the command exits 1. It works as described only " +
		"against an older hub that still issues its own tokens."
)

var reference = clidoc.Binary{
	Name:        "fleet",
	Program:     "agentpod-fleet",
	Title:       "fleet reference",
	Description: "Every fleet verb and subverb: synopsis, flags, environment, what it needs and how it exits. Generated from the binary.",
	Regenerate:  "cd apps/node-agent && go test ./cmd/agentpod-fleet -run TestReferencePage -update",
	HelpCommand: "fleet %s -h",
	Intro: "`fleet` (`agentpod-fleet`) acts on a fleet **as a principal** — a person or an agent — " +
		"from a laptop, CI or an agent's own workspace. It never uses a node's credential; acting " +
		"as a machine is [`apn`](/reference/apn/)'s job. For the reasoning behind the split, see " +
		"[apn and fleet](/use/cli/).\n\n" +
		"This page is generated from the binary's own command table and source, and a test fails " +
		"when a verb or flag exists without an entry here. Unless a command says otherwise, every " +
		"verb that talks to the hub prints the hub's JSON response unchanged on stdout: it is the " +
		"hub's shape, not a summary of it, so scripts and agents can depend on it.",
	Env: []clidoc.Env{
		{Name: "AGENTPOD_HUB", Meaning: "Hub base URL. Default `https://hub.agentpod.dev`. Never taken from a node's config."},
		{Name: "AGENTPOD_TOKEN", Meaning: "A principal's token to use instead of the stored credential. Checked first; nothing is stored. When it has expired, commands say so rather than falling back."},
		{Name: "AGENTPOD_DEVICE_NAME", Meaning: "What `fleet login` names this machine in the device list. Default: the hostname."},
		{Name: "AGENTPOD_LOGIN_TIMEOUT", Meaning: "How long the older hub sign-in waits for the browser, as a Go duration (`90s`, `10m`). Default `5m`."},
		{Name: "BROWSER", Meaning: "The command `fleet login` opens the sign-in page with (it may carry arguments). `none` opens nothing; the URL is always printed."},
	},
	Auth: "`fleet` resolves a token in this order: `$AGENTPOD_TOKEN`; a cached token that has not " +
		"expired; the stored device credential, exchanged for a fresh five-minute token. With none " +
		"of those it prints how to sign in and exits 1. The files live under your user config " +
		"directory (`~/.config/agentpod/` on Linux, `~/Library/Application Support/agentpod/` on " +
		"macOS): `token.json` and `device.json`. A device credential is only ever exchanged with the " +
		"hub and account service that issued it.\n\n" +
		"Each command below says what it needs. The hub decides; `fleet` performs no permission " +
		"check of its own and prints the hub's refusal as it came.",
	Exit: "Unless a command says otherwise:\n\n" +
		"- **0** — the hub accepted the request.\n" +
		"- **1** — no usable credential, the hub could not be reached, or the hub refused or failed " +
		"the request. Its status and body go to stderr: `401` means sign in again, `403` means this " +
		"principal may not.\n" +
		"- **2** — a usage error: an unknown verb, or a missing flag or argument. Nothing was sent.",
	Groups: []string{"Signing in", "Reading the fleet", "Nodes", "Stations", "Skills and plugins", "Administration", "This binary"},
	Commands: []clidoc.Command{
		{Path: "", Dispatch: []clidoc.Dispatch{{Func: "main", Tag: "os.Args[1]"}, {Func: "fleetCmd", Tag: "args[0]"}}, Auth: needsHuman},

		// ---- Signing in ----------------------------------------------------------------
		{
			Path: "login", Group: "Signing in",
			Summary:  "Sign in once; this machine keeps a device credential.",
			Synopsis: "fleet login",
			Detail: "Asks the hub how it signs people in. A current hub names its account service, and " +
				"`login` runs that service's device flow: it prints a page and a code, opens the page " +
				"if it can, and waits while you confirm the code in a browser — any browser, so it " +
				"works over SSH. Approval stores a long-lived **device credential** for this machine " +
				"and a first five-minute token. Every later command exchanges the device credential " +
				"for a fresh token, so the browser opens once, not once per lapse.\n\n" +
				"Against an older hub that issues its own tokens, `login` instead opens the hub's " +
				"sign-in page and receives the result on a local `127.0.0.1` callback " +
				"(authorization code with PKCE), then registers this machine as a device at the hub. " +
				"`$AGENTPOD_LOGIN_TIMEOUT` bounds that wait.\n\n" +
				"`fleet login -h` prints `fleet help` and opens nothing.",
			Auth:    "Nothing beforehand: this is how you get a credential. The sign-in itself is the account service's.",
			Exit:    "0 once signed in. 1 when the hub or account service cannot be reached, the code was denied or expired, or a credential could not be stored.",
			Example: "fleet login\nBROWSER=none fleet login   # on a server: print the page, open nothing",
		},
		{
			Path: "whoami", Group: "Signing in",
			Summary:  "Who the token says you are, read locally.",
			Synopsis: "fleet whoami [--json]",
			Detail: "Reads the token's own claims — principal, kind, expiry — plus the hub it is for and " +
				"where the token came from. It does not ask the hub, which is the point: it separates " +
				"\"not signed in\" from \"signed in, not permitted\". A `403` from another verb means " +
				"the second; this answers the first.",
			Handlers: []string{"fleetWhoami", "wantsJSON"},
			Flags:    []clidoc.Flag{{Name: "json", Usage: "print `principal`, `kind`, `source`, `hub` and `expires` as JSON"}},
			Auth:     "Any token. It may still have to be resolved, which can exchange the device credential.",
			Example:  "fleet whoami\nfleet whoami --json | jq -r .principal",
		},
		{
			Path: "logout", Group: "Signing in",
			Summary:  "Forget this machine's token and device credential.",
			Synopsis: "fleet logout",
			Detail: "Deletes both stored files. With a device credential from an account service, " +
				"signing out is **local only**: the service owns the credential, so `logout` prints " +
				"where to revoke it (its Devices page) and never sends it to the hub. With a credential " +
				"an older hub issued, it first asks that hub to revoke it, and still signs out locally " +
				"if the hub cannot be reached.",
			Auth:    "Nothing.",
			Exit:    "0 once both files are gone. 1 if a file could not be removed.",
			Example: "fleet logout",
		},
		{
			Path: "devices", Group: "Signing in",
			Summary:  "Where this machine's device credentials are listed.",
			Synopsis: "fleet devices",
			Detail: "With a device credential from an account service, prints where the devices that may " +
				"act as you are listed — the account service's Devices page — and sends nothing to the " +
				"hub. With a credential from an older hub, prints that hub's list. With no device " +
				"credential at all (a token in `$AGENTPOD_TOKEN`, say) it asks the hub, and a current hub " +
				"answers 410, which exits 1.",
			Dispatch: []clidoc.Dispatch{{Func: "fleetDevices", Tag: "args[0]"}},
			Example:  "fleet devices",
		},
		{
			Path:     "devices revoke",
			Summary:  "Revoke one device credential (older hubs).",
			Synopsis: "fleet devices revoke DEVICE_ID",
			Detail: "With a device credential from an account service, revoking happens there: this prints " +
				"its Devices page and exits 1, because nothing was revoked. Against an older hub it " +
				"revokes one of your own devices; one that is not yours and one that does not exist " +
				"are the same 404.",
			Args:    []clidoc.Arg{{Name: "DEVICE_ID", Meaning: "the device's id, as `fleet devices` lists it"}},
			Exit:    "0 when revoked. 1 when the device is managed by an account service, or the hub refused. 2 without a DEVICE_ID.",
			Example: "fleet devices revoke dev_0123456789abcdef0123",
		},

		// ---- Reading the fleet ---------------------------------------------------------
		{
			Path: "agents", Group: "Reading the fleet",
			Summary:  "The agents this token may dispatch.",
			Synopsis: "fleet agents",
			Detail: "Not every agent in the fleet: the ones the token's signed grant lets it dispatch. " +
				"The hub reads that from the token itself. Nothing granted is an empty list, not an " +
				"error.",
			Example: "fleet agents | jq '.[].name'",
		},
		{
			Path: "stats", Group: "Reading the fleet",
			Summary:  "Fleet totals.",
			Synopsis: "fleet stats",
			Example:  "fleet stats",
		},
		{
			Path: "activity", Group: "Reading the fleet",
			Summary:  "Recent activity across your stations.",
			Synopsis: "fleet activity",
			Example:  "fleet activity",
		},

		// ---- Nodes ---------------------------------------------------------------------
		{
			Path: "nodes", Group: "Nodes",
			Summary:  "The fleet's nodes, with versions.",
			Synopsis: "fleet nodes",
			Help:     nodesUsage,
			Dispatch: []clidoc.Dispatch{{Func: "fleetNodes", Tag: "args[0]"}},
			Example:  "fleet nodes",
		},
		{
			Path: "nodes update", TopHelp: true,
			Summary:  "Roll the newest release to every node, or to `--node` ones.",
			Synopsis: "fleet nodes update [--node NAME|ID ...] [--force]",
			Detail: "The hub updates one node at a time, in name order, waits for each to answer, and " +
				"skips nodes whose binary comes from an image. Only the node agent restarts; the " +
				"harnesses it serves keep running. Names are resolved to ids before anything is sent, " +
				"and an unknown name updates nothing. Waits up to 15 minutes for the whole rollout.",
			Handlers: []string{"fleetNodes"},
			Flags: []clidoc.Flag{
				{Name: "node", Arg: "NAME|ID", Repeatable: true},
				{Name: "force"},
			},
			Exit:    "0 when every node asked updated. 1 if any did not (the per-node results are printed first). 2 for an unknown `--node` name or a stray argument.",
			Example: "fleet nodes update\nfleet nodes update --node build-01 --node build-02",
		},
		{
			Path: "nodes telemetry", TopHelp: true,
			Summary:  "Read or set each node's OpenTelemetry endpoint, with no SSH.",
			Synopsis: "fleet nodes telemetry [--node NAME|ID ...] [--endpoint URL | --off]",
			Help:     nodesTelemetryUsage,
			Detail: "Without `--endpoint` or `--off`, lists one line per node: name, status, the configured " +
				"endpoint, the one it is running with when they differ, and the state of its service " +
				"unit. With one of them, sets it on every node, or only the `--node` ones; a node " +
				"restarts itself only if its setting changed. A node too old to know the verb reports " +
				"`unsupported` until `fleet nodes update`. On the node itself this is " +
				"[`apn telemetry`](/reference/apn/#apn-telemetry).",
			Handlers: []string{"fleetNodesTelemetry"},
			Flags: []clidoc.Flag{
				{Name: "node", Arg: "NAME|ID", Repeatable: true, Usage: "node name or ID; needs `--endpoint` or `--off`"},
				{Name: "endpoint", Arg: "URL"},
				{Name: "off"},
			},
			Auth:    needsAdmin,
			Exit:    "0 when every node reported (or applied) the setting. 1 if any failed or was unsupported, or — when setting — was offline. 2 for `--endpoint` with `--off`, `--node` alone, or an invalid URL.",
			Example: "fleet nodes telemetry\nfleet nodes telemetry --endpoint https://otel.example.com:4318\nfleet nodes telemetry --node build-01 --off",
		},
		{
			Path: "nodes rm", TopHelp: true,
			Summary:  "Remove a retired machine from the fleet.",
			Synopsis: "fleet nodes rm NAME|ID [--force]",
			Help:     nodesRmUsage,
			Detail: "Unregisters every station on the node, the way [`fleet stations unadopt`](#fleet-stations-unadopt) " +
				"does, and revokes the node's credential: a machine that dials back is refused, and rejoining " +
				"takes a fresh [`fleet invite`](#fleet-invite) token. Workspace files, agent identities and " +
				"Matrix rooms are kept. A connected node is refused unless `--force`, which disconnects it. " +
				"A provisioned runtime's node is refused with the [`fleet runtimes rm`](#fleet-runtimes-rm) " +
				"that removes both, and a node with a bridge-roster row on one of its stations is refused " +
				"until [`fleet bridge rm`](#fleet-bridge-rm) removes the row. A name is resolved from " +
				"`fleet nodes`; anything else is sent as an id, so a node that is not there, or not yours, is the hub's 404.",
			Handlers: []string{"fleetNodesRemove"},
			Args:     []clidoc.Arg{{Name: "NAME|ID", Meaning: "a node's name or id, from `fleet nodes`"}},
			Flags:    []clidoc.Flag{{Name: "force"}},
			Auth:     "The node's owner. Where the workspace enforces who may grow the fleet, also a workspace admin — the same authority `fleet invite` needs.",
			Exit:     "0 when the node was removed. 1 when the hub refused (the reason is printed; for a connected node, with the `--force` command) or answered 404. 2 without exactly one node.",
			Example:  "fleet nodes rm build-01\nfleet nodes rm build-01 --force",
		},
		{
			Path: "invite", Group: "Nodes",
			Summary:  "Mint the token a machine presents to `apn enroll`.",
			Synopsis: "fleet invite [--label TEXT] [--ttl-minutes N]",
			Help:     inviteUsage,
			Detail: "Creates no node: it authorises one to appear. An unredeemed invitation looks exactly " +
				"like no invitation in `fleet nodes`. The response carries the one-time token; hand it " +
				"to [`apn enroll --token`](/reference/apn/#apn-enroll).",
			Handlers: []string{"fleetInvite"},
			Flags: []clidoc.Flag{
				{Name: "label", Arg: "TEXT"},
				{Name: "ttl-minutes", Arg: "N"},
			},
			Auth:    "A person's token. When the hub enforces dispatch grants, a workspace admin's.",
			Example: "fleet invite --label \"build runner\" --ttl-minutes 30",
		},
		{
			Path: "runtimes", Group: "Nodes",
			Summary:  "The substrate nodes run on: list, providers, create, start, stop, rm.",
			Synopsis: "fleet runtimes <list|providers|create|start|stop|rm>",
			Help:     runtimesUsage,
			Detail: "The hub treats a runtime's state as evidence, not as a request's outcome: `stop` " +
				"writes `stopping`, and only the provider reporting the container down writes " +
				"`stopped`. A `stop` that returns cleanly means \"asked\"; read the state afterwards.",
			Dispatch: []clidoc.Dispatch{{Func: "fleetRuntimes", Tag: "args[0]"}},
			Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
			Example:  "fleet runtimes list",
		},
		{Path: "runtimes list", Summary: "Every runtime.", Synopsis: "fleet runtimes list", Example: "fleet runtimes list"},
		{Path: "runtimes providers", Summary: "The providers this hub can provision on.", Synopsis: "fleet runtimes providers", Example: "fleet runtimes providers"},
		{
			Path: "runtimes create", Summary: "Provision a runtime from a request document.",
			Synopsis: "fleet runtimes create --file PATH|-",
			Detail:   "The request is a JSON document the hub validates; take its shape from `fleet runtimes providers`.",
			Handlers: []string{"fleetRuntimes"},
			Flags:    []clidoc.Flag{{Name: "file", Arg: "PATH|-", Required: true}},
			Example:  "fleet runtimes create --file runtime.json",
		},
		{
			Path: "runtimes start", Summary: "Ask a runtime to start.", Synopsis: "fleet runtimes start ID",
			Args: []clidoc.Arg{{Name: "ID", Meaning: "the runtime's id"}}, Example: "fleet runtimes start rt_123",
		},
		{
			Path: "runtimes stop", Summary: "Ask a runtime to stop; its state says when it has.", Synopsis: "fleet runtimes stop ID",
			Args: []clidoc.Arg{{Name: "ID", Meaning: "the runtime's id"}}, Example: "fleet runtimes stop rt_123",
		},
		{
			Path: "runtimes rm", Summary: "Delete a runtime.", Synopsis: "fleet runtimes rm ID",
			Args: []clidoc.Arg{{Name: "ID", Meaning: "the runtime's id"}}, Example: "fleet runtimes rm rt_123",
		},

		// ---- Stations ------------------------------------------------------------------
		{
			Path: "stations", Group: "Stations",
			Summary:  "Detect, adopt and unadopt stations; grant one push access.",
			Synopsis: "fleet stations <verb> [flags]",
			Help:     stationsUsage,
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
			Path: "station", Group: "Stations",
			Summary:  "One station: lifecycle, cleanup, changeset, files.",
			Synopsis: "fleet station <lifecycle|cleanup|changeset|fs> ...",
			Help:     stationOpsUsage,
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
			Help:     staffUsage,
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
			Help:     configUsage,
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

		// ---- Skills and plugins --------------------------------------------------------
		{
			Path: "skills", Group: "Skills and plugins",
			Summary:  "Skill artifacts, releases, cohorts, canaries and placement.",
			Synopsis: "fleet skills <verb> ...",
			Help:     skillsUsage,
			Detail: "Every mutation prints the hub's reviewed record; read it before the matching apply. " +
				"No plan here ever turns into an implicit apply. The workflow is on " +
				"[Managed skills](/use/skills/).",
			Dispatch: []clidoc.Dispatch{{Func: "fleetSkills", Tag: "args[0]"}},
			Auth:     needsHuman,
			Exit:     "As below for each verb; with no verb, prints the usage and exits 0.",
			Example:  "fleet skills artifacts",
		},
		{Path: "skills artifacts", Summary: "Uploaded skill archives.", Synopsis: "fleet skills artifacts", Example: "fleet skills artifacts"},
		{
			Path: "skills artifact", Summary: "Act on one uploaded artifact.", Synopsis: "fleet skills artifact delete --id ARTIFACT_ID",
			Dispatch: []clidoc.Dispatch{{Func: "fleetSkillArtifact", Tag: "args[0]"}},
			Example:  "fleet skills artifact delete --id art_123",
		},
		{
			Path: "skills artifact delete", Summary: "Delete an uploaded artifact.",
			Synopsis: "fleet skills artifact delete --id ARTIFACT_ID",
			Handlers: []string{"fleetSkillArtifact"},
			Flags:    []clidoc.Flag{{Name: "id", Arg: "ARTIFACT_ID", Required: true}},
			Example:  "fleet skills artifact delete --id art_123",
		},
		{Path: "skills releases", Summary: "Imported catalog releases.", Synopsis: "fleet skills releases", Example: "fleet skills releases"},
		{Path: "skills cohorts", Summary: "Canary cohorts.", Synopsis: "fleet skills cohorts", Example: "fleet skills cohorts"},
		{
			Path: "skills upload", Summary: "Upload a skill archive for one harness and profile.",
			Synopsis: "fleet skills upload --harness H --profile P ARCHIVE.tgz",
			Args:     []clidoc.Arg{{Name: "ARCHIVE.tgz", Meaning: "the gzipped skill archive"}},
			Handlers: []string{"fleetSkillUpload"},
			Flags: []clidoc.Flag{
				{Name: "harness", Arg: "H", Required: true},
				{Name: "profile", Arg: "P", Required: true},
			},
			Example: "fleet skills upload --harness hermes --profile default skills-hermes.tgz",
		},
		{
			Path: "skills release", Summary: "Import a release record.", Synopsis: "fleet skills release import RELEASE.json",
			Dispatch: []clidoc.Dispatch{{Func: "fleetSkillRelease", Tag: "args[0]"}},
			Example:  "fleet skills release import release.json",
		},
		{
			Path: "skills release import", Summary: "Import a six-harness release, pinning each archive to an uploaded artifact.",
			Synopsis: "fleet skills release import RELEASE.json",
			Detail:   "Every archive the record names must already be uploaded, matched by harness, profile and SHA-256; a missing one stops the import before anything is sent.",
			Args:     []clidoc.Arg{{Name: "RELEASE.json", Meaning: "a complete release record covering all six harnesses"}},
			Example:  "fleet skills release import release.json",
		},
		{
			Path: "skills cohort", Summary: "Create a canary cohort.", Synopsis: "fleet skills cohort create --release ID --digest SHA256 --station ID",
			Dispatch: []clidoc.Dispatch{{Func: "fleetSkillCohort", Tag: "args[0]"}},
			Example:  "fleet skills cohort create --release rel_123 --digest 3f2a… --station stn_123",
		},
		{
			Path: "skills cohort create", Summary: "Create a cohort of one canary station for a release.",
			Synopsis: "fleet skills cohort create --release ID --digest SHA256 --station ID",
			Handlers: []string{"fleetSkillCohort"},
			Flags: []clidoc.Flag{
				{Name: "release", Arg: "ID", Required: true},
				{Name: "digest", Arg: "SHA256", Required: true},
				{Name: "station", Arg: "ID", Required: true},
			},
			Example: "fleet skills cohort create --release rel_123 --digest 3f2a… --station stn_123",
		},
		{
			Path: "skills canary", Summary: "Plan, inspect and apply a release on a cohort's canary.",
			Synopsis: "fleet skills canary <plan|inspect|apply> --cohort ID --release ID --digest SHA256 --station ID ...",
			Dispatch: []clidoc.Dispatch{{Func: "fleetSkillCanary", Tag: "args[0]"}},
			Example:  "fleet skills canary plan --cohort coh_123 --release rel_123 --digest 3f2a… --station stn_123",
		},
		{
			Path: "skills canary plan", Summary: "Plan the canary install.",
			Synopsis: "fleet skills canary plan --cohort ID --release ID --digest SHA256 --station ID",
			Handlers: []string{"fleetSkillCanary"},
			Flags:    canaryFlags(),
			Example:  "fleet skills canary plan --cohort coh_123 --release rel_123 --digest 3f2a… --station stn_123",
		},
		{
			Path: "skills canary inspect", Summary: "Read a canary operation.",
			Synopsis: "fleet skills canary inspect --cohort ID --release ID --digest SHA256 --station ID --operation ID",
			Handlers: []string{"fleetSkillCanary"},
			Flags:    append(canaryFlags(), clidoc.Flag{Name: "operation", Arg: "ID", Required: true}),
			Example:  "fleet skills canary inspect --cohort coh_123 --release rel_123 --digest 3f2a… --station stn_123 --operation op_123",
		},
		{
			Path: "skills canary apply", Summary: "Apply the reviewed canary plan.",
			Synopsis: "fleet skills canary apply --cohort ID --release ID --digest SHA256 --station ID --operation ID --plan-digest SHA256",
			Handlers: []string{"fleetSkillCanary"},
			Flags: append(canaryFlags(),
				clidoc.Flag{Name: "operation", Arg: "ID", Required: true},
				clidoc.Flag{Name: "plan-digest", Arg: "SHA256", Required: true}),
			Example: "fleet skills canary apply --cohort coh_123 --release rel_123 --digest 3f2a… --station stn_123 --operation op_123 --plan-digest 9c1e…",
		},
		{
			Path: "skills station", Summary: "Managed skill installs on one station.",
			Synopsis: "fleet skills station <plan|verify|rollback-plan|inspect|apply> --station ID ...",
			Dispatch: []clidoc.Dispatch{{Func: "fleetSkillStation", Tag: "args[0]"}},
			Example:  "fleet skills station verify --station stn_123 --profile default",
		},
		{
			Path: "skills station plan", Summary: "Plan installing an uploaded artifact on a station.",
			Synopsis: "fleet skills station plan --station ID --artifact ARTIFACT_ID",
			Handlers: []string{"fleetSkillStation"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "artifact", Arg: "ARTIFACT_ID", Required: true}},
			Example:  "fleet skills station plan --station stn_123 --artifact art_123",
		},
		{
			Path: "skills station verify", Summary: "Check a profile's installed skills against the record.",
			Synopsis: "fleet skills station verify --station ID --profile PROFILE",
			Handlers: []string{"fleetSkillStation"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "profile", Arg: "PROFILE", Required: true}},
			Example:  "fleet skills station verify --station stn_123 --profile default",
		},
		{
			Path: "skills station rollback-plan", Summary: "Plan rolling a profile back to its previous install.",
			Synopsis: "fleet skills station rollback-plan --station ID --profile PROFILE",
			Handlers: []string{"fleetSkillStation"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "profile", Arg: "PROFILE", Required: true}},
			Example:  "fleet skills station rollback-plan --station stn_123 --profile default",
		},
		{
			Path: "skills station inspect", Summary: "Read a station skill operation.",
			Synopsis: "fleet skills station inspect --station ID --operation ID",
			Handlers: []string{"fleetSkillStation"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "operation", Arg: "ID", Required: true}},
			Example:  "fleet skills station inspect --station stn_123 --operation op_123",
		},
		{
			Path: "skills station apply", Summary: "Apply a reviewed station skill plan.",
			Synopsis: "fleet skills station apply --station ID --operation ID --plan-digest SHA256",
			Handlers: []string{"fleetSkillStation"},
			Flags: []clidoc.Flag{
				{Name: "station", Arg: "ID", Required: true},
				{Name: "operation", Arg: "ID", Required: true},
				{Name: "plan-digest", Arg: "SHA256", Required: true},
			},
			Example: "fleet skills station apply --station stn_123 --operation op_123 --plan-digest 9c1e…",
		},
		{
			Path: "skills native", Summary: "Native placement: skills in the harness's own skill directory.",
			Synopsis: "fleet skills native <plan|inspect|apply|verify> --station ID ...",
			Detail:   "Refused unless the node's operator enabled it with [`apn native-skills enable`](/reference/apn/#apn-native-skills-enable).",
			Dispatch: []clidoc.Dispatch{{Func: "fleetSkillNative", Tag: "args[0]"}},
			Example:  "fleet skills native verify --station stn_123 --profile default",
		},
		{
			Path: "skills native plan", Summary: "Plan activating, deactivating or rolling back native placement.",
			Synopsis: "fleet skills native plan --station ID --profile PROFILE --action activate|deactivate|rollback",
			Handlers: []string{"fleetSkillNative"},
			Flags: []clidoc.Flag{
				{Name: "station", Arg: "ID", Required: true},
				{Name: "profile", Arg: "PROFILE", Required: true},
				{Name: "action", Arg: "activate|deactivate|rollback", Required: true},
			},
			Example: "fleet skills native plan --station stn_123 --profile default --action activate",
		},
		{
			Path: "skills native inspect", Summary: "Read a native placement operation.",
			Synopsis: "fleet skills native inspect --station ID --operation ID",
			Handlers: []string{"fleetSkillNative"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "operation", Arg: "ID", Required: true}},
			Example:  "fleet skills native inspect --station stn_123 --operation op_123",
		},
		{
			Path: "skills native apply", Summary: "Apply a reviewed native placement plan.",
			Synopsis: "fleet skills native apply --station ID --operation ID --plan-digest SHA256",
			Handlers: []string{"fleetSkillNative"},
			Flags: []clidoc.Flag{
				{Name: "station", Arg: "ID", Required: true},
				{Name: "operation", Arg: "ID", Required: true},
				{Name: "plan-digest", Arg: "SHA256", Required: true},
			},
			Example: "fleet skills native apply --station stn_123 --operation op_123 --plan-digest 9c1e…",
		},
		{
			Path: "skills native verify", Summary: "Check a profile's natively placed skills.",
			Synopsis: "fleet skills native verify --station ID --profile PROFILE",
			Handlers: []string{"fleetSkillNative"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "profile", Arg: "PROFILE", Required: true}},
			Example:  "fleet skills native verify --station stn_123 --profile default",
		},
		{
			Path: "plugins", Group: "Skills and plugins",
			Summary:  "Review and apply harness plugin changes on a station.",
			Synopsis: "fleet plugins <plan|show|inspect|apply|history|inventory> --station ID ...",
			Help:     pluginsUsage,
			Detail: "The node plans, you read the plan, and `apply` sends only the digest you reviewed. " +
				"Nothing here restarts a station. Refused unless the node's operator enabled it with " +
				"[`apn plugin-management enable`](/reference/apn/#apn-plugin-management-enable).",
			Dispatch: []clidoc.Dispatch{{Func: "fleetPlugins", Tag: "args[0]"}},
			Exit:     "As below for each verb; with no verb, prints the usage and exits 2.",
			Example:  "fleet plugins inventory --station stn_123",
		},
		{
			Path: "plugins plan", Summary: "Plan enabling or disabling the live-streaming plugin.",
			Synopsis: "fleet plugins plan --station ID --action enable|disable",
			Handlers: []string{"fleetPlugins"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "action", Arg: "enable|disable", Required: true}},
			Example:  "fleet plugins plan --station stn_123 --action enable",
		},
		{
			Path: "plugins show", Summary: "Read a plugin operation.",
			Synopsis: "fleet plugins show --station ID --operation ID",
			Handlers: []string{"fleetPlugins"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "operation", Arg: "ID", Required: true}},
			Example:  "fleet plugins show --station stn_123 --operation op_123",
		},
		{
			Path: "plugins inspect", Summary: "Ask the node to re-check a planned operation against the profile now.",
			Synopsis: "fleet plugins inspect --station ID --operation ID",
			Handlers: []string{"fleetPlugins"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}, {Name: "operation", Arg: "ID", Required: true}},
			Example:  "fleet plugins inspect --station stn_123 --operation op_123",
		},
		{
			Path: "plugins apply", Summary: "Apply the reviewed plan.",
			Synopsis: "fleet plugins apply --station ID --operation ID --plan-digest SHA256",
			Handlers: []string{"fleetPlugins"},
			Flags: []clidoc.Flag{
				{Name: "station", Arg: "ID", Required: true},
				{Name: "operation", Arg: "ID", Required: true},
				{Name: "plan-digest", Arg: "SHA256", Required: true},
			},
			Example: "fleet plugins apply --station stn_123 --operation op_123 --plan-digest 9c1e…",
		},
		{
			Path: "plugins history", Summary: "Past plugin operations on a station.",
			Synopsis: "fleet plugins history --station ID",
			Handlers: []string{"fleetPlugins"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}},
			Example:  "fleet plugins history --station stn_123",
		},
		{
			Path: "plugins inventory", Summary: "What the station's harness has installed.",
			Synopsis: "fleet plugins inventory --station ID",
			Handlers: []string{"fleetPlugins"},
			Flags:    []clidoc.Flag{{Name: "station", Arg: "ID", Required: true}},
			Example:  "fleet plugins inventory --station stn_123",
		},

		// ---- Administration ------------------------------------------------------------
		{
			Path: "settings", Group: "Administration",
			Summary:  "Hub-wide settings: signup, transcription, speech.",
			Synopsis: "fleet settings <show|signup|transcription|speech> ...",
			Help:     settingsUsage,
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
			Synopsis: "fleet bridge <list|add|set|rm> ...",
			Help:     bridgeUsage,
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
			Synopsis: "fleet bridge add --key K --board B --station S --token T [--mcp-token M]\n                 [--mode M] [--concurrency N] [--profile P] [--wait-ms N] [--enabled true|false]",
			Detail:   "The four required flags are reported together when missing.",
			Handlers: []string{"fleetBridge"},
			Flags: append([]clidoc.Flag{
				{Name: "key", Arg: "K", Required: true},
				{Name: "board", Arg: "B", Required: true},
				{Name: "station", Arg: "S", Required: true},
				{Name: "token", Arg: "T", Required: true},
			}, bridgeOptional()...),
			Example: "fleet bridge add --key reviewer --board brd_123 --station stn_123 --token \"$SP_TOKEN\"",
		},
		{
			Path: "bridge set", Summary: "Change some fields of a roster row; the rest stay.",
			Synopsis: "fleet bridge set KEY [--board B] [--station S] [--mode M] [--enabled true|false]\n                 [--token T] [--mcp-token M] [--concurrency N] [--profile P] [--wait-ms N]",
			Detail:   "Refuses a change with no fields, which the hub would otherwise answer 200 for and change nothing.",
			Args:     []clidoc.Arg{{Name: "KEY", Meaning: "the roster key"}},
			Handlers: []string{"fleetBridge"},
			Flags: append([]clidoc.Flag{
				{Name: "board", Arg: "B"},
				{Name: "station", Arg: "S"},
				{Name: "token", Arg: "T"},
			}, bridgeOptional()...),
			Example: "fleet bridge set reviewer --board brd_456",
		},
		{
			Path: "bridge rm", Summary: "Remove a roster row.", Synopsis: "fleet bridge rm KEY",
			Args: []clidoc.Arg{{Name: "KEY", Meaning: "the roster key"}}, Example: "fleet bridge rm reviewer",
		},
		{
			Path: "principals", Group: "Administration",
			Summary:  "Identities, service principals and their credentials.",
			Synopsis: "fleet principals <verb> ...",
			Help:     principalsUsage,
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
			Help:     grantsUsage,
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
			Help:     usersUsage,
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
	},
}

func canaryFlags() []clidoc.Flag {
	return []clidoc.Flag{
		{Name: "cohort", Arg: "ID", Required: true},
		{Name: "release", Arg: "ID", Required: true},
		{Name: "digest", Arg: "SHA256", Required: true},
		{Name: "station", Arg: "ID", Required: true},
	}
}

func bridgeOptional() []clidoc.Flag {
	return []clidoc.Flag{
		{Name: "mcp-token", Arg: "M"},
		{Name: "mode", Arg: "M"},
		{Name: "concurrency", Arg: "N", Usage: "max cards at once; 0 leaves the hub's value"},
		{Name: "profile", Arg: "P"},
		{Name: "wait-ms", Arg: "N", Usage: "how long a permission request waits for an answer, in ms; 0 leaves the hub's value"},
		{Name: "enabled", Arg: "true|false"},
	}
}
