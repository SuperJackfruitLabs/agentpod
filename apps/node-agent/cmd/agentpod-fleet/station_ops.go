package main

import (
	"encoding/base64"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const stationOpsUsage = `usage:
  fleet station lifecycle --station ID --action start|stop|restart
  fleet station cleanup plan --station ID
  fleet station cleanup apply --station ID --path P [--path P …]
  fleet station changeset status --station ID [--base REF]
  fleet station changeset diff --station ID --side uncommitted|committed [--path P] [--base REF]
  fleet station fs write  --station ID --path P --from FILE|- [--base64] [--backup]
  fleet station fs mkdir  --station ID --path P
  fleet station fs move   --station ID --from P --to P
  fleet station fs delete --station ID --path P [--recursive]`

// fleetStationOps is the operational half of a station: lifecycle, disk, diffs, files.
//
// Separate from `fleet stations` (which detects, adopts and lists) because those act on the
// fleet's SHAPE and these act on one station's CONTENTS. Keeping them in one verb would make
// `fleet stations delete` ambiguous between unadopting a station and deleting a file in it.
//
// Every verb here is a node round trip through the hub's broker, so an offline node answers
// 409 and the hub's message says which. Nothing is retried: a write that may or may not have
// landed is the one thing a caller must decide about itself.
func fleetStationOps(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(stationOpsUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	switch args[0] {
	case "lifecycle":
		fs, station := stationFlags("lifecycle")
		action := fs.String("action", "", "start, stop or restart")
		fs.Parse(args[1:])
		id := stationOpID(*station)
		if *action != "start" && *action != "stop" && *action != "restart" {
			fmt.Fprintf(os.Stderr, "lifecycle requires --action start|stop|restart\n\n%s\n", stationOpsUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, stationPath(id)+"/lifecycle", map[string]any{"action": *action})
	case "cleanup":
		fleetStationCleanup(args[1:])
	case "changeset":
		fleetStationChangeset(args[1:])
	case "fs":
		fleetStationFS(args[1:])
	default:
		fmt.Fprintln(os.Stderr, stationOpsUsage)
		os.Exit(2)
	}
}

func fleetStationCleanup(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, stationOpsUsage)
		os.Exit(2)
	}
	fs, station := stationFlags("cleanup")
	var paths repeatable
	fs.Var(&paths, "path", "a path to reclaim (repeatable)")
	fs.Parse(args[1:])
	id := stationOpID(*station)
	switch args[0] {
	case "plan":
		fleetSkillJSON(http.MethodPost, stationPath(id)+"/cleanup/plan", map[string]any{})
	case "apply":
		if len(paths) == 0 {
			// The hub requires at least one path. Enforced here too, because an empty apply is
			// far more likely to be a shell glob that matched nothing than a deliberate no-op.
			fmt.Fprintf(os.Stderr, "apply requires at least one --path\n\n%s\n", stationOpsUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, stationPath(id)+"/cleanup/apply", map[string]any{"paths": []string(paths)})
	default:
		fmt.Fprintln(os.Stderr, stationOpsUsage)
		os.Exit(2)
	}
}

func fleetStationChangeset(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, stationOpsUsage)
		os.Exit(2)
	}
	fs, station := stationFlags("changeset")
	base := fs.String("base", "", "ref to compare against")
	side := fs.String("side", "", "uncommitted or committed")
	path := fs.String("path", "", "limit the diff to one path")
	fs.Parse(args[1:])
	id := stationOpID(*station)
	body := map[string]any{}
	if *base != "" {
		body["base"] = *base
	}
	switch args[0] {
	case "status":
		fleetSkillJSON(http.MethodPost, stationPath(id)+"/changeset/status", body)
	case "diff":
		if *side != "uncommitted" && *side != "committed" {
			fmt.Fprintf(os.Stderr, "diff requires --side uncommitted|committed\n\n%s\n", stationOpsUsage)
			os.Exit(2)
		}
		body["side"] = *side
		if *path != "" {
			body["path"] = *path
		}
		fleetSkillJSON(http.MethodPost, stationPath(id)+"/changeset/diff", body)
	default:
		fmt.Fprintln(os.Stderr, stationOpsUsage)
		os.Exit(2)
	}
}

func fleetStationFS(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, stationOpsUsage)
		os.Exit(2)
	}
	fs, station := stationFlags("fs")
	path := fs.String("path", "", "path on the station")
	from := fs.String("from", "", "local file to send, or - for stdin (write); source path (move)")
	to := fs.String("to", "", "destination path (move)")
	asBase64 := fs.Bool("base64", false, "send the file as base64 rather than utf8")
	backup := fs.Bool("backup", false, "keep a backup of what was overwritten")
	recursive := fs.Bool("recursive", false, "delete a directory and its contents")
	fs.Parse(args[1:])
	id := stationOpID(*station)
	base := stationPath(id) + "/fs/"

	switch args[0] {
	case "write":
		if *path == "" || *from == "" {
			fmt.Fprintf(os.Stderr, "write requires --path and --from\n\n%s\n", stationOpsUsage)
			os.Exit(2)
		}
		raw := readDocument(*from)
		body := map[string]any{"path": *path, "backup": *backup}
		if *asBase64 {
			body["content"] = base64.StdEncoding.EncodeToString(raw)
			body["encoding"] = "base64"
		} else {
			// Refused rather than silently mangled: utf8 is the default because most writes are
			// text, and a binary sent as utf8 arrives corrupted with nothing to show for it.
			if !utf8Clean(raw) {
				fmt.Fprintln(os.Stderr, "that file is not valid UTF-8 — send it with --base64")
				os.Exit(2)
			}
			body["content"] = string(raw)
			body["encoding"] = "utf8"
		}
		fleetSkillJSON(http.MethodPost, base+"write", body)
	case "mkdir":
		if *path == "" {
			fmt.Fprintf(os.Stderr, "mkdir requires --path\n\n%s\n", stationOpsUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"mkdir", map[string]any{"path": *path})
	case "move":
		if *from == "" || *to == "" {
			fmt.Fprintf(os.Stderr, "move requires --from and --to\n\n%s\n", stationOpsUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"move", map[string]any{"from": *from, "to": *to})
	case "delete":
		if *path == "" {
			fmt.Fprintf(os.Stderr, "delete requires --path\n\n%s\n", stationOpsUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"delete", map[string]any{"path": *path, "recursive": *recursive})
	default:
		fmt.Fprintln(os.Stderr, stationOpsUsage)
		os.Exit(2)
	}
}

func stationFlags(name string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet("fleet station "+name, flag.ExitOnError)
	return fs, fs.String("station", "", "station ID")
}

// stationOpID validates the flag every verb in this family needs, deferring to the message
// `fleet stations` already uses so an operator sees one phrasing for one mistake.
func stationOpID(id string) string {
	requireStation(strings.TrimSpace(id), "station commands")
	return id
}

func stationPath(id string) string { return "/api/stations/" + url.PathEscape(id) }

// repeatable collects a flag given more than once.
type repeatable []string

func (r *repeatable) String() string     { return strings.Join(*r, ",") }
func (r *repeatable) Set(v string) error { *r = append(*r, v); return nil }

func utf8Clean(b []byte) bool { return strings.ToValidUTF8(string(b), "�") == string(b) }
