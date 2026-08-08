package main

import (
	"fmt"
	"strings"
)

// command describes one top-level apn verb: its group for the top-level
// help layout, a one-line summary for that layout, and a longer detail
// block used both by `apn help <command>` and wired onto the command's own
// flag.FlagSet.Usage (so `apn <command> -h` shows the same text plus flag
// defaults). This slice is the single source of truth for all three
// surfaces — a command missing here is a command missing from help.
var commands = []struct {
	name, group, oneline, detail string
}{
	{
		name: "status", group: "Service",
		oneline: "Show local service + hub connection state (--json for scripts)",
		detail: "apn status — show local service state and hub connection state.\n\n" +
			"Local block: whether the service is installed / enabled / running (with\n" +
			"PID), the binary version, and the config path. Hub block: reachability\n" +
			"and credential validity, checked against the existing\n" +
			"GET /public/nodes/credential-check endpoint (no new endpoints).\n\n" +
			"Exit code is 0 iff the service is running AND the stored hub credential\n" +
			"is valid — safe to use in scripts/health checks.",
	},
	{
		name: "start", group: "Service",
		oneline: "Enable and start the background service",
		detail: "apn start — enable and start the background service (the symmetric\n" +
			"inverse of 'apn stop').\n\n" +
			"macOS: `launchctl enable` + `launchctl bootstrap`. Linux: `systemctl\n" +
			"[--user] enable --now`.\n\n" +
			"If no service is installed yet, this prints a hint pointing at\n" +
			"'apn service install' (or run in the foreground with 'apn run').",
	},
	{
		name: "stop", group: "Service",
		oneline: "Stop and disable the service (sticky across reboots)",
		detail: "apn stop — stop the service AND disable it (sticky across\n" +
			"reboots/logins — it will not come back on its own).\n\n" +
			"macOS: `launchctl bootout` + `launchctl disable`. Linux: `systemctl\n" +
			"[--user] stop` + `disable`.\n\n" +
			"Undo with 'apn start' — it re-enables and starts.",
	},
	{
		name: "restart", group: "Service",
		oneline: "Restart the running service",
		detail: "apn restart — restart the running service in place.\n\n" +
			"macOS: `launchctl kickstart -k`. Linux: `systemctl [--user] restart`.",
	},
	{
		name: "logs", group: "Service",
		oneline: "Show service logs (-f to follow, -n N for last N lines)",
		detail: "apn logs [-f] [-n N] — show service logs.\n\n" +
			"macOS: reads/tails ~/Library/Logs/agentpod-node.log.\n" +
			"Linux: execs `journalctl [--user] -u agentpod-node [-f] [-n N]`.",
	},
	{
		name: "service", group: "Service",
		oneline: "install | uninstall the platform service (launchd/systemd)",
		detail: "apn service <install|uninstall> — manage the platform service\n" +
			"definition.\n\n" +
			"install: writes a plist (macOS LaunchAgent) or systemd unit from a\n" +
			"template embedded in the binary, then enables and starts it.\n" +
			"Idempotent — re-running replaces the file and restarts. Non-root\n" +
			"Linux uses a --user unit; root Linux uses a system unit; macOS uses a\n" +
			"LaunchAgent (refuses to run as root).\n\n" +
			"uninstall: stops, disables, and removes the plist/unit. Idempotent —\n" +
			"a no-op when nothing is installed. Leaves config/enrollment untouched.",
	},
	{
		name: "enroll", group: "Node",
		oneline: "Enroll this machine with a hub (--hub, --token, --force)",
		detail: "apn enroll [--hub URL] [--token TOKEN] [--force] — enroll this\n" +
			"machine with a hub.\n\n" +
			"Falls back to the AGENTPOD_HUB_URL/AGENTPOD_ENROLL_TOKEN environment\n" +
			"variables when the flags are omitted. Idempotent: running it again on\n" +
			"an already-enrolled machine is a friendly no-op unless the stored\n" +
			"credential is no longer valid, or --force is passed.",
	},
	{
		name: "run", group: "Node",
		oneline: "Run the agent in the foreground",
		detail: "apn run — run the agent in the foreground: connects to the hub and\n" +
			"handles terminal sessions until interrupted (Ctrl-C).\n\n" +
			"This is what the installed service runs under the hood; run it\n" +
			"directly for debugging.",
	},
	{
		name: "detect", group: "Node",
		oneline: "Print detected harness stations as JSON",
		detail: "apn detect — print the harness stations detected on this host as\n" +
			"JSON. Debug/ops smoke test for the descriptors; no hub connection\n" +
			"required.",
	},
	{
		name: "update", group: "Maintenance",
		oneline: "Self-update from the latest release (--check, --force)",
		detail: "apn update [--check] [--force] — self-update from the latest GitHub\n" +
			"release.\n\n" +
			"--check resolves and reports the current/latest version without\n" +
			"changing anything. --force updates even when already on the latest\n" +
			"version. On success the service is restarted automatically; if the\n" +
			"restart fails, the binary is already swapped and this prints a\n" +
			"manual-restart hint.",
	},
	{
		name: "version", group: "Maintenance",
		oneline: "Print version and platform",
		detail:  "apn version — print the binary version and platform (GOOS/GOARCH).",
	},
}

// commandGroups lists the group names in the order they render in the
// top-level help layout.
var commandGroups = []string{"Service", "Node", "Maintenance"}

// helpText renders the full top-level `apn help` layout: tool one-liner and
// version, usage line, commands grouped by purpose, an examples block, and
// a closing hint. Matches the layout in the design spec's "Help & CLI UX"
// section exactly, since that mock is also the acceptance bar.
func helpText(version string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "agentpod-node (apn) — AgentPod fleet node agent  %s\n\n", version)
	b.WriteString("Usage: apn <command> [flags]\n\n")

	for _, group := range commandGroups {
		fmt.Fprintf(&b, "%s:\n", group)
		for _, c := range commands {
			if c.group == group {
				fmt.Fprintf(&b, "  %-12s%s\n", c.name, c.oneline)
			}
		}
		b.WriteString("\n")
	}

	b.WriteString("Examples:\n")
	b.WriteString("  apn status\n")
	b.WriteString("  apn logs -f\n")
	b.WriteString("  apn enroll --hub https://hub.example.com --token <TOKEN>\n\n")
	b.WriteString("Run 'apn help <command>' or 'apn <command> -h' for command details.")

	return b.String()
}

// commandHelp returns the detail text for a registered command, or "" if
// name is not a known command. Used by `apn help <command>` and by each
// command's own flag.FlagSet.Usage.
func commandHelp(name string) string {
	for _, c := range commands {
		if c.name == name {
			return c.detail
		}
	}
	return ""
}

// isCommand reports whether name is a registered top-level command.
func isCommand(name string) bool {
	for _, c := range commands {
		if c.name == name {
			return true
		}
	}
	return false
}

// suggestCommand returns the registered command name closest to the
// (presumably mistyped) input, or "" if nothing is within edit distance 2 —
// close enough to be a plausible typo (like "statsu" -> "status") without
// suggesting an unrelated command for a genuinely unknown verb.
func suggestCommand(input string) string {
	const maxSuggestDistance = 2
	best, bestDist := "", maxSuggestDistance+1
	for _, c := range commands {
		if d := levenshtein(input, c.name); d < bestDist {
			best, bestDist = c.name, d
		}
	}
	if bestDist <= maxSuggestDistance {
		return best
	}
	return ""
}

// levenshtein computes the edit distance between two strings (insert,
// delete, substitute each cost 1) using the standard single-row
// dynamic-programming table. Byte-based: fine for the ASCII command names
// this is used against.
func levenshtein(a, b string) int {
	prevRow := make([]int, len(b)+1)
	for j := range prevRow {
		prevRow[j] = j
	}
	for i := 1; i <= len(a); i++ {
		curRow := make([]int, len(b)+1)
		curRow[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			curRow[j] = min3(curRow[j-1]+1, prevRow[j]+1, prevRow[j-1]+cost)
		}
		prevRow = curRow
	}
	return prevRow[len(b)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}
