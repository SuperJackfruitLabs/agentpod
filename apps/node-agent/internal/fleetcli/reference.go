package fleetcli

import (
	"slices"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"
)

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

var Reference = clidoc.Binary{
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
		{Name: "AGENTPOD_HUB", Meaning: "Hub base URL. Else the hub the stored login (token.json) was made against, else `https://hub.agentpod.dev`. Never taken from a node's config."},
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
	Commands: slices.Concat(
		[]clidoc.Command{
			{Path: "", Dispatch: []clidoc.Dispatch{{Func: "main", Tag: "os.Args[1]"}, {Func: "fleetCmd", Tag: "args[0]"}}, Auth: needsHuman},
		},
		fleetCommands,
		stationCommands,
		skillCommands,
		adminCommands,
	),
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
