package main

// `fleet …` — acting as a PRINCIPAL against a hub, rather than as this machine.
//
// The split between this and `apn node …` is the credential, not the verb list. Everything in
// `node` authenticates as `<nodeId>:<nodeSecret>` from the node's own config; everything here
// authenticates with a hub-issued token that a person or an agent holds.
//
// **A fleet command never falls back to the node's secret.** That rule lives in
// `internal/fleetcred` with the test that pins it.
//
// This file adds no authority of its own and performs no client-side permission check. It
// renders the hub's answer, including the hub's refusal. A client that pre-empts a server
// decision is a client that will one day disagree with it.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcred"
)

const defaultHub = "https://hub.agentpod.dev"

// hubBase is the hub a fleet command talks to: the environment, else the default.
//
// Deliberately NOT the node config's `hub` field. A machine enrolled against one hub does not
// make that hub the one a person is signed in to, and quietly borrowing it would blur the very
// boundary this mode exists to draw.
func hubBase() string {
	if h := strings.TrimSpace(os.Getenv(fleetcred.EnvHub)); h != "" {
		return strings.TrimRight(h, "/")
	}
	return defaultHub
}

// fleetCmd dispatches `fleet <verb>`.
func fleetCmd(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(helpText(version))
		return
	}
	switch args[0] {
	case "login":
		fleetLogin(args[1:])
	case "whoami":
		fleetWhoami(args[1:])
	case "logout":
		fleetLogout()
	case "nodes":
		fleetGet("/api/nodes", args[1:])
	case "agents":
		fleetGet("/api/fleet/agents", args[1:])
	case "stats":
		fleetGet("/api/fleet/stats", args[1:])
	case "activity":
		fleetGet("/api/activity", args[1:])
	case "skills":
		fleetSkills(args[1:])
	case "devices":
		fleetDevices(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown fleet command: %q\n\n%s\n", args[0], helpText(version))
		os.Exit(2)
	}
}

// requireCredential resolves the fleet token or exits with a message naming the fix.
//
// It exits rather than returning an error because every caller's response is identical, and
// because the one thing it must never do — reach for the node's credential — is easiest to
// guarantee when there is a single place that can decide.
func requireCredential() fleetcred.Credential {
	// `Resolve`, not `Load`: the environment, then a cached token that is still good, then the
	// device credential exchanged for a fresh one. That third step is what stopped a lapsed
	// five-minute token from meaning a browser
	// (charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md).
	c, err := fleetcred.Resolve(hubBase())
	if err != nil {
		fmt.Fprintf(os.Stderr,
			"Not signed in to a fleet.\n\n"+
				"  fleet login            sign in and store a token\n"+
				"  %s=…   supply one directly\n\n"+
				"This is separate from `apn enroll`, which gives this MACHINE an identity.\n"+
				"A node's credential is never used to act on the fleet.\n",
			fleetcred.EnvToken)
		os.Exit(1)
	}
	// Reachable now only for a token supplied through $AGENTPOD_TOKEN: `Resolve` exchanges the
	// device credential rather than handing back anything stale, so a device-holding operator
	// never sees this. Which is why the hint names the variable rather than `fleet login` — the
	// thing to change is the one the caller actually set.
	if claims, err := fleetcred.Inspect(c.Token); err == nil && claims.Expired() {
		fmt.Fprintf(os.Stderr,
			"The token in %s expired at %s.\n\n"+
				"  fleet login            sign in on this machine instead, and stop supplying one\n",
			c.Source, claims.Expiry.Local().Format(time.RFC1123))
		os.Exit(1)
	}
	return c
}

// fleetWhoami reports what the operator is carrying, without asking the hub.
//
// The point is to separate two failures that otherwise look identical from the outside: "not
// signed in" and "signed in, not permitted". A 403 means the second; this command answers the
// first, locally, in one line.
func fleetWhoami(args []string) {
	c := requireCredential()
	claims, err := fleetcred.Inspect(c.Token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "The stored credential is not a token this can read: %v\n", err)
		os.Exit(1)
	}
	if wantsJSON(args) {
		out := map[string]any{
			"principal": claims.Subject,
			"kind":      claims.PrincipalKind,
			"source":    c.Source,
			"hub":       hubBase(),
		}
		if !claims.Expiry.IsZero() {
			out["expires"] = claims.Expiry.UTC().Format(time.RFC3339)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(out)
		return
	}
	fmt.Printf("principal  %s\n", claims.Subject)
	fmt.Printf("kind       %s\n", claims.PrincipalKind)
	fmt.Printf("hub        %s\n", hubBase())
	fmt.Printf("token from %s\n", c.Source)
	if !claims.Expiry.IsZero() {
		fmt.Printf("expires    %s\n", claims.Expiry.Local().Format(time.RFC1123))
	}
}

// fleetLogout removes this machine's credentials, and revokes the device credential at the hub
// first.
//
// **Signing out stopped being a purely local act** when a ninety-day credential started living
// on disk. Deleting the file and leaving the row live would mean an operator who signed out
// still had a working credential in the hub's table — visible in the inventory, revocable by
// nobody who thought they had already dealt with it.
//
// A hub that cannot be reached does NOT stop the local removal. Being unable to reach the hub is
// exactly when someone most wants the secret off this disk, and the credential expires on its
// own in ninety days. The failure is reported rather than swallowed, with the id, so it can be
// revoked from the console or another machine.
func fleetLogout() {
	if d, err := fleetcred.LoadDevice(); err == nil {
		hub := d.Hub
		if hub == "" {
			hub = hubBase()
		}
		if err := fleetcred.RevokeDevice(hub, d); err != nil {
			fmt.Fprintf(os.Stderr,
				"Signed out on this machine, but the hub did not confirm revoking %s: %v\n\n"+
					"  fleet devices revoke %s   from another machine\n"+
					"It expires on its own within 90 days.\n",
				d.ID, err, d.ID)
		}
	}
	if err := fleetcred.ForgetDevice(); err != nil {
		fmt.Fprintf(os.Stderr, "could not remove the stored device credential: %v\n", err)
		os.Exit(1)
	}
	if err := fleetcred.Forget(); err != nil {
		fmt.Fprintf(os.Stderr, "could not remove the stored token: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("signed out")
}

// fleetDevices lists the devices that may act as this principal, or revokes one.
//
// The record this implements asks for devices to be "a thing an operator can see and name in a
// list". This is that list; the console carries the same one for the person whose laptop was
// stolen and who is, by then, not at that laptop.
func fleetDevices(args []string) {
	if len(args) > 0 && args[0] == "revoke" {
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: fleet devices revoke <deviceId>")
			os.Exit(2)
		}
		c := requireCredential()
		if err := fleetcred.RevokeDeviceByID(hubBase(), c.Token, args[1]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("revoked %s\n", args[1])
		return
	}
	fleetGet("/api/auth/devices", args)
}

func wantsJSON(args []string) bool {
	for _, a := range args {
		if a == "--json" || a == "-json" {
			return true
		}
	}
	return false
}

// fleetGet performs an authenticated read and prints the hub's answer.
//
// The body is passed through rather than reformatted. A CLI that renders a summary of a payload
// it does not fully model is a CLI that silently drops the field somebody needed — and `--json`
// is the surface agents will depend on, so it stays the hub's own shape.
func fleetGet(path string, args []string) {
	c := requireCredential()
	req, err := http.NewRequest("GET", hubBase()+path, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not reach %s: %v\n", hubBase(), err)
		os.Exit(1)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)

	if res.StatusCode == http.StatusForbidden {
		// Distinguished from 401 on purpose: 401 means sign in, 403 means you may not. The hub
		// refuses a non-human principal here, and an agent reading "sign in again" would loop.
		fmt.Fprintf(os.Stderr, "Refused by the hub (403). %s\n", strings.TrimSpace(string(body)))
		os.Exit(1)
	}
	if res.StatusCode == http.StatusUnauthorized {
		fmt.Fprintf(os.Stderr, "The hub did not accept that token (401).\n\n  fleet login\n")
		os.Exit(1)
	}
	if res.StatusCode >= 400 {
		fmt.Fprintf(os.Stderr, "hub returned %d: %s\n", res.StatusCode, strings.TrimSpace(string(body)))
		os.Exit(1)
	}
	fmt.Println(strings.TrimSpace(string(body)))
}
