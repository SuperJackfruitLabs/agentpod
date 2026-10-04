package main

import "fmt"

// helpText is this binary's whole help. It is one block rather than a table
// because there is one command group: everything here acts as a principal.
func helpText(version string) string {
	return fmt.Sprintf(`agentpod-fleet (fleet) — act on an AgentPod fleet as a PRINCIPAL  v%s

Usage: fleet <verb> [flags]

  fleet login                sign in once; this machine keeps a device credential
  fleet whoami [--json]      who the stored token says you are
  fleet logout               revoke this device and forget both credentials
  fleet devices [--json]     machines that may act as you
  fleet devices revoke <id>  revoke one
  fleet nodes                the fleet's nodes
  fleet nodes update         roll the newest release to every node (or --node NAME)
  fleet agents               the agents you may dispatch
  fleet stations …           detect, adopt and unadopt stations on a node
  fleet stats                fleet totals
  fleet activity             recent fleet activity
  fleet skills …             manage skill artifacts, releases and canaries
  fleet plugins …            review and apply plugin changes on a station
  fleet station …            ONE station: lifecycle, cleanup, changeset, fs
  fleet runtimes …           the substrate nodes run on
  fleet invite               mint a token a machine presents to apn enroll
  fleet staff …              put an agent in a station, or take it out
  fleet settings …           hub-wide config: signup, transcription, speech

  fleet bridge …             the superpipeline roster: which agent claims from
                             which board, onto which station
  fleet users …              people: list, show, ban, unban, role
  fleet principals …         identities: list, suspend, restore, add-service,
                             add-credential, revoke-credential
  fleet grants …             dispatch authority, as a document

  fleet update [--check]     replace this binary with the newest release
  fleet version              print version and platform
  fleet help                 this text

The credential is a person's or an agent's, never a machine's. `+"`apn enroll`"+` gives THIS
MACHINE an identity; these verbs use a hub-issued token from $AGENTPOD_TOKEN or the
files `+"`fleet login`"+` writes. A fleet command never falls back to a node's
credential — a node secret says 'I am this host', and that is not an authority to
operate the fleet.

Hub tokens last five minutes. `+"`fleet login`"+` also registers this machine as a device,
and every later command exchanges that credential for a fresh token — so the browser
opens once, not once per lapse. The device credential lasts 90 days and renews itself
whenever it is used. `+"`fleet devices`"+` lists them; `+"`fleet logout`"+` revokes this one.

What is NOT here, deliberately: anything that acts as THIS MACHINE rather than as you
(that is apn), and the interactive surfaces — a terminal, an ACP session — which are a
console's job rather than a script's. Everything else the hub exposes should be reachable
from here; if it is not, that is a gap rather than a decision.

Set $AGENTPOD_HUB to talk to a hub other than the default, and
$AGENTPOD_DEVICE_NAME to name this machine in the device list.`, version)
}

// helpRequested reports whether args' first element is a help flag. Only the
// first argument is checked, matching the flag package's own behaviour of
// treating a later "-h" as an ordinary value.
func helpRequested(args []string) bool {
	return len(args) > 0 && (args[0] == "-h" || args[0] == "--help")
}
