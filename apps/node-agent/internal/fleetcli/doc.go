// Package fleetcli holds what the fleet CLI says and the pieces of its work that need no
// dispatch: the command reference rendered into docs-site's fleet.md and `fleet help`, the
// usage texts, the node-telemetry row rendering, declared-value parsing for `fleet config`,
// forge API rule and credential parsing, the login code exchange and random ids. Dispatch,
// flag parsing and the hub calls stay in cmd/agentpod-fleet, where the reference test and the
// docs check read them.
package fleetcli
