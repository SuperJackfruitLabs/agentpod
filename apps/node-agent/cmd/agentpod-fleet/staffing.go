package main

import (
	"bytes"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
)

const staffUsage = `usage:
  fleet staff options
  fleet staff create --file PATH|-
  fleet staff assign --station ID --file PATH|-
  fleet staff unassign --station ID`

// fleetStaff puts an agent in a station, and takes it out again.
//
// Named `staff` rather than folded into `fleet agents` because that verb READS the fleet —
// `fleet agents` lists every station across every node, and has since before this existed.
// Overloading it with writes would mean `fleet agents` alone and `fleet agents create`
// answering about different things: one about what is running, one about what is configured.
//
// `options` first in the usage on purpose: it is what tells you which harnesses, models and
// profiles this hub will accept, and every other verb here fails on a value it did not get
// from there.
func fleetStaff(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(staffUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	switch args[0] {
	case "options":
		fleetGet("/api/admin/station-setup/options", args)
	case "create":
		fs := flag.NewFlagSet("fleet staff create", flag.ExitOnError)
		file := fs.String("file", "", "agent definition, or - for stdin")
		fs.Parse(args[1:])
		if *file == "" {
			fmt.Fprintf(os.Stderr, "create requires --file PATH or --file -\n\n%s\n", staffUsage)
			os.Exit(2)
		}
		fleetSkillRequest(http.MethodPost, "/api/admin/agents", bytes.NewReader(readDocument(*file)), "application/json")
	case "assign":
		fs := flag.NewFlagSet("fleet staff assign", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		file := fs.String("file", "", "assignment document, or - for stdin")
		fs.Parse(args[1:])
		id := stationOpID(*station)
		if *file == "" {
			fmt.Fprintf(os.Stderr, "assign requires --file PATH or --file -\n\n%s\n", staffUsage)
			os.Exit(2)
		}
		fleetSkillRequest(http.MethodPut, "/api/admin/stations/"+url.PathEscape(id)+"/agent",
			bytes.NewReader(readDocument(*file)), "application/json")
	case "unassign":
		fs := flag.NewFlagSet("fleet staff unassign", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		fs.Parse(args[1:])
		id := stationOpID(*station)
		fleetSkillJSON(http.MethodDelete, "/api/admin/stations/"+url.PathEscape(id)+"/agent", nil)
	default:
		fmt.Fprintln(os.Stderr, staffUsage)
		os.Exit(2)
	}
}

const settingsUsage = `usage:
  fleet settings show
  fleet settings signup [enable|disable]
  fleet settings transcription [show|set --file PATH|- |test]
  fleet settings speech [show|set --file PATH|- |test]`

// fleetSettings reads and changes hub-wide configuration.
//
// `signup` with no argument reads rather than toggles. A verb that flips a boolean because
// you forgot to say which way is a verb that will one day reopen signup on a live hub —
// so the read is the default and each direction has to be named.
func fleetSettings(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(settingsUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/admin/settings"
	switch args[0] {
	case "show":
		fleetGet(base, args)
	case "signup":
		if len(args) == 1 {
			fleetGet(base+"/signup", args)
			return
		}
		if args[1] != "enable" && args[1] != "disable" {
			fmt.Fprintf(os.Stderr, "signup takes enable or disable, got %q\n\n%s\n", args[1], settingsUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"/signup/"+args[1], map[string]any{})
	case "transcription", "speech":
		settingsSubresource(base+"/"+args[0], args[0], args[1:])
	default:
		fmt.Fprintln(os.Stderr, settingsUsage)
		os.Exit(2)
	}
}

// settingsSubresource serves transcription and speech, which the hub mounts with the same
// three routes. One function rather than two near-identical ones: a second copy is where the
// two quietly stop behaving the same.
func settingsSubresource(base, name string, args []string) {
	if len(args) == 0 {
		fleetGet(base, nil)
		return
	}
	switch args[0] {
	case "show":
		fleetGet(base, args)
	case "test":
		fleetSkillJSON(http.MethodPost, base+"/test", map[string]any{})
	case "set":
		fs := flag.NewFlagSet("fleet settings "+name+" set", flag.ExitOnError)
		file := fs.String("file", "", "settings document, or - for stdin")
		fs.Parse(args[1:])
		if *file == "" {
			fmt.Fprintf(os.Stderr, "set requires --file PATH or --file -\n\n%s\n", settingsUsage)
			os.Exit(2)
		}
		fleetSkillRequest(http.MethodPut, base, bytes.NewReader(readDocument(*file)), "application/json")
	default:
		fmt.Fprintln(os.Stderr, settingsUsage)
		os.Exit(2)
	}
}
