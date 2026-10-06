package main

import (
	"fmt"
	"os"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcred"
)

// fleetLoginPlane signs in through the organization plane's device flow (contract §3.2).
//
// No loopback listener and no PKCE: the human approves a code on the plane's page, which also
// works over SSH. The approved poll yields a 90-day device credential (stored first, so a failed
// exchange below still leaves a usable credential), and the first exchange proves it works.
func fleetLoginPlane(hub string, p fleetcred.Plane) {
	dc, err := fleetcred.StartDeviceFlow(p)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// verification_uri_complete is OPTIONAL in RFC 8628; without it the human types the code.
	page := dc.VerificationURIComplete
	if page == "" {
		page = dc.VerificationURI
	}
	fmt.Printf("To sign in, open:\n\n  %s\n\nand confirm the code %s\n\n", page, dc.UserCode)
	openBrowser(page)

	d, err := fleetcred.WaitForDevice(p, dc, time.Sleep)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	d.Hub = hub
	d.Name = deviceName()
	if err := fleetcred.SaveDevice(d); err != nil {
		fmt.Fprintf(os.Stderr, "could not store the device credential: %v\n", err)
		os.Exit(1)
	}
	token, err := fleetcred.ExchangeAtPlane(d)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := fleetcred.Save(token, hub); err != nil {
		fmt.Fprintf(os.Stderr, "could not store the token: %v\n", err)
		os.Exit(1)
	}
	if c, err := fleetcred.Inspect(token); err == nil {
		fmt.Printf("Signed in as %s (%s)\n", c.Subject, c.PrincipalKind)
	}
	fmt.Printf("Device credential stored at %s\n", fleetcred.DevicePath())
}
