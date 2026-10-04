package main

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const grantsUsage = `usage:
  fleet grants list
  fleet grants show PRINCIPAL_ID
  fleet grants set PRINCIPAL_ID --file PATH|-
  fleet grants rm PRINCIPAL_ID`

// fleetGrants reads and writes dispatch authority: which principals a principal may
// dispatch work to.
//
// `set` takes a FILE rather than flags. A grant is a document, not a field — the hub
// validates its whole shape, and flattening it into flags would mean this CLI modelling
// a schema the hub owns, then disagreeing with it the first time the schema moves.
// `-` reads stdin, so a grant can be piped from whatever produced it.
func fleetGrants(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(grantsUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/admin/grants"
	switch args[0] {
	case "list":
		fleetGet(base, args)
	case "show":
		fleetGet(base+"/"+url.PathEscape(needArg(args, 1, "show", grantsUsage)), args)
	case "set":
		id := needArg(args, 1, "set", grantsUsage)
		fs := flag.NewFlagSet("fleet grants set", flag.ExitOnError)
		file := fs.String("file", "", "grant document, or - for stdin")
		fs.Parse(args[2:])
		if *file == "" {
			fmt.Fprintf(os.Stderr, "set requires --file PATH or --file -\n\n%s\n", grantsUsage)
			os.Exit(2)
		}
		fleetSkillRequest(http.MethodPut, base+"/"+url.PathEscape(id), bytes.NewReader(readDocument(*file)), "application/json")
	case "rm":
		fleetSkillJSON(http.MethodDelete, base+"/"+url.PathEscape(needArg(args, 1, "rm", grantsUsage)), nil)
	default:
		fmt.Fprintln(os.Stderr, grantsUsage)
		os.Exit(2)
	}
}

const principalsUsage = `usage:
  fleet principals list
  fleet principals suspend ID
  fleet principals restore ID
  fleet principals add-service HANDLE --client CLIENT --scope SCOPE[,SCOPE]
  fleet principals revoke-credential SVC_ID`

// fleetPrincipals lists the identities the hub knows, and suspends or restores one.
//
// Suspension is reversible and restore is its exact inverse, which is why both are here
// and deletion is not: removing a principal is not an operational action, it is a decision
// about a record other tables point at.
func fleetPrincipals(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(principalsUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/admin/principals"
	switch args[0] {
	case "list":
		fleetGet(base, args)
	case "suspend", "restore":
		id := needArg(args, 1, args[0], principalsUsage)
		fleetSkillJSON(http.MethodPost, base+"/"+url.PathEscape(id)+"/"+args[0], map[string]any{})
	case "add-service":
		// Prints the credential's secret ONCE, in the hub's response. Pipe it straight into the
		// service's secret file; it is not retrievable afterwards.
		handle := needArg(args, 1, "add-service", principalsUsage)
		fs := flag.NewFlagSet("fleet principals add-service", flag.ExitOnError)
		client := fs.String("client", "", "the HUB_OAUTH_CLIENTS id whose audiences its tokens carry")
		scope := fs.String("scope", "", "comma-separated grant scopes, e.g. evidence:read")
		fs.Parse(args[2:])
		if *client == "" || *scope == "" {
			fmt.Fprintf(os.Stderr, "add-service requires --client and --scope\n\n%s\n", principalsUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, "/api/admin/service-principals", map[string]any{
			"handle": handle, "oauthClient": *client, "scopes": strings.Split(*scope, ","),
		})
	case "revoke-credential":
		id := needArg(args, 1, "revoke-credential", principalsUsage)
		fleetSkillJSON(http.MethodPost, "/api/admin/service-principals/credentials/"+url.PathEscape(id)+"/revoke", map[string]any{})
	default:
		fmt.Fprintln(os.Stderr, principalsUsage)
		os.Exit(2)
	}
}

const usersUsage = `usage:
  fleet users list
  fleet users show ID
  fleet users ban ID --reason "why" [--expires RFC3339]
  fleet users unban ID
  fleet users role ID --role ROLE`

// fleetUsers is people, not agents — the hub's own accounts.
//
// `ban` requires a reason. The hub may or may not enforce that; this asks for it anyway,
// because a ban with no recorded reason is one nobody can review later, and the person
// who lifts it will not be the person who applied it.
func fleetUsers(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(usersUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/admin/users"
	switch args[0] {
	case "list":
		fleetGet(base, args)
	case "show":
		fleetGet(base+"/"+url.PathEscape(needArg(args, 1, "show", usersUsage)), args)
	case "ban":
		id := needArg(args, 1, "ban", usersUsage)
		fs := flag.NewFlagSet("fleet users ban", flag.ExitOnError)
		reason := fs.String("reason", "", "why, recorded with the ban")
		expires := fs.String("expires", "", "RFC3339 instant the ban lifts itself")
		fs.Parse(args[2:])
		if *reason == "" {
			fmt.Fprintf(os.Stderr, "ban requires --reason\n\n%s\n", usersUsage)
			os.Exit(2)
		}
		body := map[string]any{"reason": *reason}
		if *expires != "" {
			body["expiresAt"] = *expires
		}
		fleetSkillJSON(http.MethodPost, base+"/"+url.PathEscape(id)+"/ban", body)
	case "unban":
		id := needArg(args, 1, "unban", usersUsage)
		fleetSkillJSON(http.MethodPost, base+"/"+url.PathEscape(id)+"/unban", map[string]any{})
	case "role":
		id := needArg(args, 1, "role", usersUsage)
		fs := flag.NewFlagSet("fleet users role", flag.ExitOnError)
		role := fs.String("role", "", "the role to set")
		fs.Parse(args[2:])
		if *role == "" {
			fmt.Fprintf(os.Stderr, "role requires --role ROLE\n\n%s\n", usersUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPut, base+"/"+url.PathEscape(id)+"/role", map[string]any{"role": *role})
	default:
		fmt.Fprintln(os.Stderr, usersUsage)
		os.Exit(2)
	}
}

// needArg returns args[i], or exits with the family's usage.
//
// Shared by every verb here because "which argument was missing" is the one thing a usage
// error has to say, and repeating the check per verb is how one of them ends up saying
// something less useful than the others.
func needArg(args []string, i int, verb, usage string) string {
	if len(args) <= i || args[i] == "" {
		fmt.Fprintf(os.Stderr, "%s requires an ID\n\n%s\n", verb, usage)
		os.Exit(2)
	}
	return args[i]
}

// readDocument reads a file, or stdin when the path is "-".
func readDocument(path string) []byte {
	var (
		b   []byte
		err error
	)
	if path == "-" {
		b, err = io.ReadAll(os.Stdin)
	} else {
		b, err = os.ReadFile(path)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not read %s: %v\n", path, err)
		os.Exit(1)
	}
	return b
}
