package main

import (
	"flag"
	"fmt"
	"net/http"
)

const inviteUsage = `usage:
  fleet invite [--label TEXT] [--ttl-minutes N]`

// fleetInvite mints the token a machine presents to `apn enroll`.
//
// Here rather than under `nodes` because it creates no node: it authorises one to appear.
// The distinction matters when reading `fleet nodes` afterwards and finding nothing — the
// token is an invitation, and an unredeemed invitation looks exactly like no invitation.
//
// The hub decides the default lifetime; this sends one only when asked, rather than
// restating a policy that is the hub's to hold.
func fleetInvite(args []string) {
	if helpRequested(args) {
		fmt.Println(inviteUsage)
		return
	}
	fs := flag.NewFlagSet("fleet invite", flag.ExitOnError)
	label := fs.String("label", "", "what this token is for, recorded with it")
	ttl := fs.Int("ttl-minutes", 0, "minutes until it expires (hub default when unset)")
	fs.Parse(args)
	body := map[string]any{}
	if *label != "" {
		body["label"] = *label
	}
	if *ttl > 0 {
		body["ttlMinutes"] = *ttl
	}
	fleetSkillJSON(http.MethodPost, "/api/enrollment-tokens", body)
}
