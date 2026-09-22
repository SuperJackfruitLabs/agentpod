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
  fleet agents               the agents you may dispatch
  fleet stations …           detect, adopt and unadopt stations on a node
  fleet stats                fleet totals
  fleet activity             recent fleet activity
  fleet skills …             manage skill artifacts, releases and canaries

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

Set $AGENTPOD_HUB to talk to a hub other than the default, and
$AGENTPOD_DEVICE_NAME to name this machine in the device list.`, version)
}

// helpRequested reports whether args' first element is a help flag. Only the
// first argument is checked, matching the flag package's own behaviour of
// treating a later "-h" as an ordinary value.
func helpRequested(args []string) bool {
	return len(args) > 0 && (args[0] == "-h" || args[0] == "--help")
}
