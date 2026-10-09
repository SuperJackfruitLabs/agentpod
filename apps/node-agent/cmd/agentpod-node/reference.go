package main

import (
	"fmt"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"
)

// The command reference, rendered into docs-site/src/content/docs/reference/apn.md.
//
// Top-level commands take their group, summary and help text from `commands` in help.go — the
// same table `apn help` prints — so the page shows what the binary says. This file adds what the
// help table does not carry: subverbs, flags, what each needs, how it exits, and an example.
// reference_test.go fails when a verb, subverb, flag or environment variable exists in the
// source without an entry, or when the committed page is not what this renders.

const (
	apnNeedsNothing = "Nothing: no enrolment, no hub, no network."
	apnNeedsService = "The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root)."
	apnNeedsLocal   = "The user the node service runs as, editing its own files. No hub contact."
	apnHermesNote   = "Without `--apply` it prints the exact change and writes nothing. It never restarts a gateway; that is the operator's call."
)

// apnRef holds, per path, what the reference adds to the help table. Top-level paths must be
// commands in help.go; deeper paths are subverbs.
var apnRef = []clidoc.Command{
	{Path: "", Dispatch: []clidoc.Dispatch{{Func: "main", Tag: "os.Args[1]"}}},

	// ---- Service ----------------------------------------------------------------------
	{
		Path: "status", Synopsis: "apn status [--json]",
		Handlers: []string{"parseStatusFlags"},
		Flags:    []clidoc.Flag{{Name: "json", Usage: "print the local and hub state as one JSON object"}},
		Auth:     "The node's enrolled credential, for the hub check. Not enrolled is reported, not an error.",
		Exit:     "0 only when the service is running **and** the hub accepts the stored credential; 1 otherwise. Safe in a health check.",
		Example:  "apn status\napn status --json | jq .hub",
	},
	{Path: "start", Synopsis: "apn start", Auth: apnNeedsService, Example: "apn start"},
	{Path: "stop", Synopsis: "apn stop", Auth: apnNeedsService, Example: "apn stop"},
	{Path: "restart", Synopsis: "apn restart", Auth: apnNeedsService, Example: "apn restart"},
	{
		Path: "logs", Synopsis: "apn logs [-f] [-n N]",
		Handlers: []string{"prepareLogsCmd"},
		Flags:    []clidoc.Flag{{Name: "f"}, {Name: "n", Arg: "N"}},
		Auth:     apnNeedsService,
		Example:  "apn logs -n 200\napn logs -f",
	},
	{
		Path: "service", Synopsis: "apn service <install|uninstall>",
		Dispatch: []clidoc.Dispatch{{Func: "runServiceVerb", Tag: "verb"}},
		Auth:     apnNeedsService,
		Example:  "apn service install",
	},
	{
		Path: "service install", Summary: "Write the service definition, enable it and start it.",
		Synopsis: "apn service install",
		Detail:   "Idempotent: re-running replaces the plist or unit and restarts the service.",
		Example:  "apn service install",
	},
	{
		Path: "service uninstall", Summary: "Stop, disable and remove the service definition.",
		Synopsis: "apn service uninstall",
		Detail:   "A no-op when nothing is installed. Configuration and enrolment are left alone, so `apn service install` brings the same node back.",
		Example:  "apn service uninstall",
	},
	{
		Path: "telemetry", Synopsis: "apn telemetry <status|enable|disable>",
		Detail: "The file is `/etc/agentpod-node/otel.env` for a system unit and " +
			"`~/.config/agentpod-node/otel.env` for a user unit. From elsewhere, an admin can do the " +
			"same to every node with [`fleet nodes telemetry`](/reference/fleet/#fleet-nodes-telemetry).",
		Dispatch: []clidoc.Dispatch{{Func: "telemetryCmd", Tag: "verb"}},
		Auth:     apnNeedsService,
		Exit:     "As below for each verb; 1 on macOS, where it is unsupported; 2 for an unknown verb.",
		Example:  "apn telemetry status",
	},
	{
		Path: "telemetry status", Summary: "The config path, endpoint, on or off, and whether the collector answers.",
		Synopsis: "apn telemetry status [--json]",
		Handlers: []string{"telemetryCmd"},
		Flags:    []clidoc.Flag{{Name: "json"}},
		Example:  "apn telemetry status --json",
	},
	{
		Path: "telemetry enable", Summary: "Turn export on to an endpoint and restart the service.",
		Synopsis: "apn telemetry enable --endpoint URL",
		Detail:   "The URL is validated (http or https only) before anything is written. Nothing restarts when the file would not change.",
		Handlers: []string{"telemetryCmd"},
		Flags:    []clidoc.Flag{{Name: "endpoint", Arg: "URL", Required: true}},
		Example:  "apn telemetry enable --endpoint https://otel.example.com:4318",
	},
	{
		Path: "telemetry disable", Summary: "Comment the endpoint out and restart the service.",
		Synopsis: "apn telemetry disable",
		Example:  "apn telemetry disable",
	},

	// ---- Node -------------------------------------------------------------------------
	{
		Path: "node", Synopsis: "apn node <verb> [flags]",
		Auth:    "Whatever the verb needs.",
		Example: "apn node status   # the same as apn status",
	},
	{
		Path: "enroll", Synopsis: "apn enroll [--hub URL] [--token TOKEN] [--force] [--otlp-endpoint URL]",
		Detail: "Writes this machine's identity to `~/.config/agentpod-node/config.json` (Linux) or " +
			"`~/Library/Application Support/agentpod-node/config.json` (macOS). Re-enrolling replaces " +
			"only the identity and keeps every local setting, including the native-skill and " +
			"plugin-management gates. Mint the token with [`fleet invite`](/reference/fleet/#fleet-invite).",
		Handlers: []string{"main/enroll"},
		Flags: []clidoc.Flag{
			{Name: "hub", Arg: "URL", Default: "`$AGENTPOD_HUB_URL`"},
			{Name: "token", Arg: "TOKEN", Default: "`$AGENTPOD_ENROLL_TOKEN`", Usage: "one-time enrollment token from `fleet invite`"},
			{Name: "force"},
			{Name: "otlp-endpoint", Arg: "URL"},
		},
		Auth:    "A one-time enrollment token — the machine's invitation, not a person's token.",
		Exit:    "0 when enrolled, or already enrolled and kept. 1 when the hub or token is missing, the hub refused the token, or the config could not be written.",
		Example: "apn enroll --hub https://hub.agentpod.dev --token \"$ENROLL_TOKEN\"\nAGENTPOD_HUB_URL=https://hub.agentpod.dev AGENTPOD_ENROLL_TOKEN=… apn enroll",
	},
	{
		Path: "run", Synopsis: "apn run",
		Detail:  "Reads the OpenTelemetry variables below at start. Exits when interrupted.",
		Auth:    "The node's enrolled credential. Without one it exits 1 and says to enroll.",
		Example: "apn run",
	},
	{
		Path: "native-skills", Synopsis: "apn native-skills <status|enable|disable>",
		Dispatch: []clidoc.Dispatch{{Func: "nativeSkillsCmd", Tag: "args[0]"}},
		Auth:     apnNeedsLocal,
		Example:  "apn native-skills status",
	},
	{Path: "native-skills status", Summary: "Whether native placement is enabled on this node.", Synopsis: "apn native-skills status", Exit: "0; 1 when the node is not enrolled.", Example: "apn native-skills status"},
	{Path: "native-skills enable", Summary: "Allow native skill placement; restart the service afterwards.", Synopsis: "apn native-skills enable", Example: "apn native-skills enable && apn restart"},
	{Path: "native-skills disable", Summary: "Refuse native skill placement; restart the service afterwards.", Synopsis: "apn native-skills disable", Example: "apn native-skills disable && apn restart"},
	{
		Path: "plugin-management", Synopsis: "apn plugin-management <status|enable|disable>",
		Detail:   "The fleet side of this is [`fleet plugins`](/reference/fleet/#fleet-plugins).",
		Dispatch: []clidoc.Dispatch{{Func: "pluginManagementCmd", Tag: "args[0]"}},
		Auth:     apnNeedsLocal,
		Example:  "apn plugin-management status",
	},
	{Path: "plugin-management status", Summary: "Whether the console may manage plugins on this node.", Synopsis: "apn plugin-management status", Exit: "0; 1 when the node is not enrolled.", Example: "apn plugin-management status"},
	{Path: "plugin-management enable", Summary: "Allow console plugin management; restart the service afterwards.", Synopsis: "apn plugin-management enable", Example: "apn plugin-management enable && apn restart"},
	{Path: "plugin-management disable", Summary: "Refuse console plugin management; restart the service afterwards.", Synopsis: "apn plugin-management disable", Example: "apn plugin-management disable && apn restart"},
	{
		Path: "mcp-proxy", Synopsis: "apn mcp-proxy <status|rotate [STATION_ID...]>",
		Detail: "The proxy's per-station secrets and its loopback port persist in `mcp-proxy.json` " +
			"(owner-only, 0600) beside the node config, so a session kept open across a node restart " +
			"keeps working. Which stations it serves is changed from the hub, audited: " +
			"[`fleet mcp-proxy`](/reference/fleet/#fleet-mcp-proxy).",
		Dispatch: []clidoc.Dispatch{{Func: "mcpProxyCmd", Tag: "args[0]"}},
		Auth:     apnNeedsLocal,
		Example:  "apn mcp-proxy status",
	},
	{Path: "mcp-proxy status", Summary: "The stations the proxy serves, and whether each has a persisted secret. No secret is printed.", Synopsis: "apn mcp-proxy status", Exit: "0; 1 when the node is not enrolled.", Example: "apn mcp-proxy status"},
	{
		Path: "mcp-proxy rotate", Summary: "Replace the named stations' secrets — every served station when none are named.",
		Synopsis: "apn mcp-proxy rotate [STATION_ID...]",
		Detail: "The running node re-reads the state file at the next request: a session holding an old " +
			"secret is refused (401) from then on, with no restart, and new sessions get the new one. " +
			"The fleet side is [`fleet mcp-proxy rotate`](/reference/fleet/#fleet-mcp-proxy-rotate).",
		Exit:    "0; 1 when the node is not enrolled or a named station is not served (nothing is rotated then).",
		Example: "apn mcp-proxy rotate station_123",
	},
	{
		Path: "hermes-skills", Synopsis: "apn hermes-skills <status|register|unregister> --profile NAME [--apply]",
		Dispatch: []clidoc.Dispatch{{Func: "hermesSkillsCmd", Tag: "action"}},
		Auth:     apnNeedsLocal,
		Example:  "apn hermes-skills status --profile default",
	},
	{
		Path: "hermes-skills status", Summary: "Whether the profile's config names the managed skills directory.",
		Synopsis: "apn hermes-skills status --profile NAME",
		Handlers: []string{"hermesSkillsCmd"}, Flags: []clidoc.Flag{hermesProfile()},
		Example: "apn hermes-skills status --profile default",
	},
	{
		Path: "hermes-skills register", Summary: "Add the managed skills directory to `skills.external_dirs`.",
		Synopsis: "apn hermes-skills register --profile NAME [--apply]", Detail: apnHermesNote,
		Handlers: []string{"hermesSkillsCmd"}, Flags: []clidoc.Flag{hermesProfile(), hermesApply()},
		Example: "apn hermes-skills register --profile default          # show the change\napn hermes-skills register --profile default --apply  # make it",
	},
	{
		Path: "hermes-skills unregister", Summary: "Undo what `register` changed.",
		Synopsis: "apn hermes-skills unregister --profile NAME [--apply]", Detail: apnHermesNote,
		Handlers: []string{"hermesSkillsCmd"}, Flags: []clidoc.Flag{hermesProfile(), hermesApply()},
		Example: "apn hermes-skills unregister --profile default --apply",
	},
	{
		Path: "hermes-live", Synopsis: "apn hermes-live <status|enable|disable> --profile NAME [--apply] [--replace-unmanaged]",
		Dispatch: []clidoc.Dispatch{{Func: "hermesLiveCmd", Tag: "action"}},
		Auth:     apnNeedsLocal,
		Example:  "apn hermes-live status --profile default",
	},
	{
		Path: "hermes-live status", Summary: "The plugin's install state, the Hermes version and whether it is a tested one.",
		Synopsis: "apn hermes-live status --profile NAME",
		Handlers: []string{"hermesLiveCmd"}, Flags: []clidoc.Flag{hermesProfile()},
		Example: "apn hermes-live status --profile default",
	},
	{
		Path: "hermes-live enable", Summary: "Install the shipped plugin and enable it in the profile's config.",
		Synopsis: "apn hermes-live enable --profile NAME [--apply] [--replace-unmanaged]",
		Detail:   "Refused on a Hermes version the plugin was not tested against. " + apnHermesNote,
		Handlers: []string{"hermesLiveCmd"},
		Flags: []clidoc.Flag{hermesProfile(), hermesApply(),
			{Name: "replace-unmanaged", Usage: "replace a plugin directory of the same name that this apn did not install"}},
		Example: "apn hermes-live enable --profile default --apply\nsystemctl --user restart hermes-gateway-default.service",
	},
	{
		Path: "hermes-live disable", Summary: "Remove the plugin and undo the config edit.",
		Synopsis: "apn hermes-live disable --profile NAME [--apply]", Detail: apnHermesNote,
		Handlers: []string{"hermesLiveCmd"}, Flags: []clidoc.Flag{hermesProfile(), hermesApply()},
		Example: "apn hermes-live disable --profile default --apply",
	},
	{
		Path: "openclaw-errors", Synopsis: "apn openclaw-errors <status|enable|disable> [--apply]",
		Detail:   "See [When a turn fails](/use/errors/).",
		Dispatch: []clidoc.Dispatch{{Func: "openclawErrorsCmd", Tag: "action"}},
		Auth:     apnNeedsLocal,
		Example:  "apn openclaw-errors status",
	},
	{Path: "openclaw-errors status", Summary: "The plugin's install state, the OpenClaw version and whether it is a tested one.", Synopsis: "apn openclaw-errors status", Example: "apn openclaw-errors status"},
	{
		Path: "openclaw-errors enable", Summary: "Install the shipped plugin and register it in `~/.openclaw/openclaw.json`.",
		Synopsis: "apn openclaw-errors enable [--apply]", Detail: "Refused on an OpenClaw version the plugin was not tested against. " + apnHermesNote,
		Handlers: []string{"openclawErrorsCmd"}, Flags: []clidoc.Flag{hermesApply()},
		Example: "apn openclaw-errors enable --apply",
	},
	{
		Path: "openclaw-errors disable", Summary: "Remove the plugin and its registration.",
		Synopsis: "apn openclaw-errors disable [--apply]", Detail: apnHermesNote,
		Handlers: []string{"openclawErrorsCmd"}, Flags: []clidoc.Flag{hermesApply()},
		Example: "apn openclaw-errors disable --apply",
	},
	{
		Path: "pi-errors", Synopsis: "apn pi-errors <status|enable|disable> [--apply]",
		Detail:   "See [When a turn fails](/use/errors/).",
		Dispatch: []clidoc.Dispatch{{Func: "piErrorsCmd", Tag: "action"}},
		Auth:     apnNeedsLocal,
		Example:  "apn pi-errors status",
	},
	{Path: "pi-errors status", Summary: "The extension's install state, the Pi version and whether it is a tested one.", Synopsis: "apn pi-errors status", Example: "apn pi-errors status"},
	{
		Path: "pi-errors enable", Summary: "Install the shipped extension into Pi's extensions directory.",
		Synopsis: "apn pi-errors enable [--apply]", Detail: "Refused on a Pi version the extension was not tested against. Without `--apply` it prints what it would do and writes nothing. Nothing needs restarting.",
		Handlers: []string{"piErrorsCmd"}, Flags: []clidoc.Flag{hermesApply()},
		Example: "apn pi-errors enable --apply",
	},
	{
		Path: "pi-errors disable", Summary: "Remove the extension.",
		Synopsis: "apn pi-errors disable [--apply]", Detail: "Without `--apply` it prints what it would do and writes nothing.",
		Handlers: []string{"piErrorsCmd"}, Flags: []clidoc.Flag{hermesApply()},
		Example: "apn pi-errors disable --apply",
	},
	{Path: "detect", Synopsis: "apn detect", Auth: apnNeedsNothing, Example: "apn detect | jq '.[].key'"},
	{
		Path: "scan", Synopsis: "apn scan [--json] [--no-color]",
		Detail:   "See [Checking for exposure](/use/scan/).",
		Handlers: []string{"scanCmd"},
		Flags:    []clidoc.Flag{{Name: "json"}, {Name: "no-color", Usage: "disable ANSI colour (it is already off when stdout is not a terminal)"}},
		Auth:     apnNeedsNothing,
		Exit:     "0 clean, 1 warnings, 2 critical.",
		Example:  "apn scan\napn scan --json > posture.json",
	},
	{
		Path: "acp", Synopsis: "apn acp --list [--hub URL]\napn acp --station ID [--session ID] [--hub URL]",
		Detail:   "See [Attaching an editor](/use/acp/).",
		Handlers: []string{"acpCmd"},
		Flags: []clidoc.Flag{
			{Name: "list"},
			{Name: "station", Arg: "ID", Usage: "station to attach to; required unless `--list`"},
			{Name: "session", Arg: "ID"},
			{Name: "hub", Arg: "URL", Default: "`$AGENTPOD_HUB`, else `https://hub.agentpod.dev`"},
			{Name: "token", Arg: "TOKEN", Default: "`$AGENTPOD_TOKEN`"},
		},
		Auth:    "A person's access token, from `$AGENTPOD_TOKEN` or `--token` — never this host's credential, and never the file `fleet login` writes. Needs no enrolled node.",
		Exit:    "0 when the editor closes the session. 1 when the hub refuses or drops it. 2 without `--station` or `--list`.",
		Example: "AGENTPOD_TOKEN=… apn acp --list\nAGENTPOD_TOKEN=… apn acp --station stn_123",
	},

	// ---- Maintenance ------------------------------------------------------------------
	{
		Path: "update", Synopsis: "apn update [--check] [--force]",
		Handlers: []string{"main/update"},
		Flags:    []clidoc.Flag{{Name: "check"}, {Name: "force"}},
		Auth:     "Network access to GitHub releases, and write access to the binary's own path. The download is verified against the release's `SHA256SUMS`.",
		Exit:     "0 when up to date, updated, or (with `--check`) reported. 1 when the release could not be fetched or verified, or the binary was swapped but the restart failed (the right restart command is printed).",
		Example:  "apn update --check\napn update",
	},
	{Path: "version", Synopsis: "apn version", Auth: apnNeedsNothing, Exit: "0.", Example: "apn version   # agentpod-node v0.1.90 linux/amd64"},
	{
		Path: "help", Synopsis: "apn help [COMMAND]\napn -h\napn",
		Args:    []clidoc.Arg{{Name: "COMMAND", Meaning: "one command, to print its detail"}},
		Auth:    apnNeedsNothing,
		Exit:    "0; 2 for an unknown COMMAND.",
		Example: "apn help\napn help enroll",
	},
}

func hermesProfile() clidoc.Flag {
	return clidoc.Flag{Name: "profile", Arg: "NAME", Required: true, Usage: "the Hermes profile, a directory under `~/.hermes/profiles/`"}
}

func hermesApply() clidoc.Flag {
	return clidoc.Flag{Name: "apply", Usage: "make the change; without it, print what would change and write nothing"}
}

// apnReference merges the help table with apnRef. It panics on a mismatch between the two,
// which the reference test turns into a failure before anything is rendered.
func apnReference() clidoc.Binary {
	byPath := map[string]clidoc.Command{}
	for _, r := range apnRef {
		byPath[r.Path] = r
	}
	out := []clidoc.Command{byPath[""]}
	for _, c := range commands {
		r, ok := byPath[c.name]
		if !ok {
			panic(fmt.Sprintf("apn %s is in the help table but has no entry in apnRef", c.name))
		}
		r.Group = c.group
		r.Summary = clidoc.CodeFlags(strings.ToUpper(c.oneline[:1]) + strings.TrimSuffix(c.oneline[1:], ".") + ".")
		r.Help = c.detail
		out = append(out, r)
		for _, sub := range apnRef {
			if strings.HasPrefix(sub.Path, c.name+" ") {
				out = append(out, sub)
			}
		}
	}
	for _, r := range apnRef {
		if r.Path != "" && !strings.Contains(r.Path, " ") && !isCommand(r.Path) {
			panic(fmt.Sprintf("apnRef has apn %s, which is not in the help table", r.Path))
		}
	}
	return clidoc.Binary{
		Name:        "apn",
		Program:     "agentpod-node",
		Title:       "apn reference",
		Description: "Every apn command and subcommand: synopsis, flags, environment, what it needs and how it exits. Generated from the binary.",
		Regenerate:  "cd apps/node-agent && go test ./cmd/agentpod-node -run TestReferencePage -update",
		HelpCommand: "apn help %s",
		Intro: "`apn` (`agentpod-node`) is the resident agent on an enrolled host. Every command acts " +
			"on **this machine**: its service, its enrolment, the harnesses installed on it. Acting " +
			"on the fleet as a person is [`fleet`](/reference/fleet/)'s job, and `apn` never reads " +
			"the credential `fleet login` stores. For the reasoning behind the split, see " +
			"[apn and fleet](/use/cli/).\n\n" +
			"Each command's text below is what `apn help <command>` prints, from the same table in " +
			"the binary. `apn node <command>` is the same as `apn <command>`. This page is generated " +
			"from that table and the source, and a test fails when a command or flag exists without " +
			"an entry here.",
		Env: []clidoc.Env{
			{Name: "AGENTPOD_HUB_URL", Meaning: "`apn enroll`: the hub, when `--hub` is not given."},
			{Name: "AGENTPOD_ENROLL_TOKEN", Meaning: "`apn enroll`: the one-time enrollment token, when `--token` is not given."},
			{Name: "AGENTPOD_HUB", Meaning: "`apn acp`: the hub, when `--hub` is not given. Default `https://hub.agentpod.dev`."},
			{Name: "AGENTPOD_TOKEN", Meaning: "`apn acp`: a person's access token. Prefer it to `--token`, which lands in shell history."},
			{Name: "OTEL_EXPORTER_OTLP_ENDPOINT", Meaning: "`apn run`: the OTLP/HTTP collector to export traces to; unset exports nothing. Normally written to `otel.env` by `apn telemetry enable`."},
			{Name: "OTEL_SDK_DISABLED", Meaning: "`apn run`: `true` turns export off even with an endpoint set."},
		},
		Auth: "Commands that talk to the hub use **this machine's** credential, stored by `apn enroll` " +
			"in the node config (`~/.config/agentpod-node/config.json` on Linux, " +
			"`~/Library/Application Support/agentpod-node/config.json` on macOS). It says \"I am this " +
			"host\" and nothing more. The exceptions are `apn enroll`, which spends a one-time " +
			"enrollment token, and `apn acp`, which takes a person's token explicitly.",
		Exit: "Unless a command says otherwise:\n\n" +
			"- **0** — it did what it was asked.\n" +
			"- **1** — it failed; the reason is on stderr.\n" +
			"- **2** — a usage error: an unknown command, verb or argument. Nothing was changed.\n\n" +
			"`-h` or `--help` as the first argument prints the command's help and exits 0 before " +
			"anything else runs, so `apn stop -h` never stops the service.",
		Groups:   commandGroups,
		Commands: out,
	}
}
