package main

import "fmt"

// helpText is this binary's whole help. It is one block rather than a table
// because there is one command group: everything here acts as a principal.
func helpText(version string) string {
	return fmt.Sprintf(`agentpod-fleet (fleet) — act on an AgentPod fleet as a PRINCIPAL  v%s

Usage: fleet <verb> [flags]

  fleet login                sign in and store a hub token
  fleet whoami [--json]      who the stored token says you are
  fleet logout               forget the stored token
  fleet nodes                the fleet's nodes
  fleet agents               the agents you may dispatch
  fleet stats                fleet totals
  fleet activity             recent fleet activity

  fleet version              print version and platform
  fleet help                 this text

The credential is a person's or an agent's, never a machine's. `+"`apn enroll`"+` gives THIS
MACHINE an identity; these verbs use a hub-issued token from $AGENTPOD_TOKEN or the
file `+"`fleet login`"+` writes. A fleet command never falls back to a node's
credential — a node secret says 'I am this host', and that is not an authority to
operate the fleet.

Set $AGENTPOD_HUB to talk to a hub other than the default.`, version)
}

// helpRequested reports whether args' first element is a help flag. Only the
// first argument is checked, matching the flag package's own behaviour of
// treating a later "-h" as an ordinary value.
func helpRequested(args []string) bool {
	return len(args) > 0 && (args[0] == "-h" || args[0] == "--help")
}
