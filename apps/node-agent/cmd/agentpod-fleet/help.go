package main

import (
	"fmt"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/clidoc"
)

// helpText is this binary's whole help: the verb list, rendered from the command reference
// (reference.go) so the list and the reference page cannot disagree, then how credentials work.
func helpText(version string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "agentpod-fleet (fleet) — act on an AgentPod fleet as a PRINCIPAL  v%s\n\n", version)
	b.WriteString("Usage: fleet <verb> [flags]\n")
	for _, group := range reference.Groups {
		b.WriteString("\n")
		for _, c := range reference.TopLevel(group) {
			helpLine(&b, c)
			for _, sub := range reference.Commands {
				if sub.TopHelp && strings.HasPrefix(sub.Path, c.Path+" ") {
					helpLine(&b, sub)
				}
			}
		}
	}
	b.WriteString(credentialsHelp)
	return b.String()
}

// helpLine writes one verb: its path, with an ellipsis when it has subcommands, and its summary
// as plain text.
func helpLine(b *strings.Builder, c clidoc.Command) {
	name := "fleet " + c.Path
	for _, k := range reference.Commands {
		if strings.HasPrefix(k.Path, c.Path+" ") && !k.TopHelp {
			name += " …"
			break
		}
	}
	fmt.Fprintf(b, "  %-26s %s\n", name, strings.ReplaceAll(c.Summary, "`", ""))
}

const credentialsHelp = `
The credential is a person's or an agent's, never a machine's. ` + "`apn enroll`" + ` gives THIS
MACHINE an identity; these verbs use a principal's token from $AGENTPOD_TOKEN or the
credential ` + "`fleet login`" + ` stores. A fleet command never falls back to a node's
credential — a node secret says 'I am this host', and that is not an authority to
operate the fleet.

Tokens last five minutes. ` + "`fleet login`" + ` signs in through your workspace's account
service: it prints a code to confirm in a browser (any browser, so it works over SSH)
and stores a device credential that every later command exchanges for a fresh token —
so the browser opens once, not once per lapse. The account service's Devices page lists
and revokes devices; ` + "`fleet devices`" + ` says where it is, and ` + "`fleet logout`" + ` signs this
machine out locally. (A hub without an account service signs you in itself, and lists
and revokes devices here.)

What is NOT here, deliberately: anything that acts as THIS MACHINE rather than as you
(that is apn), and the interactive surfaces — a terminal, an ACP session — which are a
console's job rather than a script's.

Set $AGENTPOD_HUB to talk to a hub other than the default, and
$AGENTPOD_DEVICE_NAME to name this machine in the device list.
Every verb, flag and variable: https://docs.agentpod.dev/reference/fleet/`

// helpRequested reports whether args' first element is a help flag. Only the
// first argument is checked, matching the flag package's own behaviour of
// treating a later "-h" as an ordinary value.
func helpRequested(args []string) bool {
	return len(args) > 0 && (args[0] == "-h" || args[0] == "--help")
}
