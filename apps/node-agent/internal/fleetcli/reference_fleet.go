package fleetcli

import "github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"

// fleetCommands holds the reference's entries for signing in, reading the fleet, and nodes, in page order. See Reference.
var fleetCommands = []clidoc.Command{
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
		Help:     NodesUsage,
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
		Help:     NodesTelemetryUsage,
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
		Help:     NodesRmUsage,
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
		Help:     InviteUsage,
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
		Help:     RuntimesUsage,
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
}
