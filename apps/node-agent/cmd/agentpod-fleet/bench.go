package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcli"
)

// fleetBench sets up SuperBench stages from the hub: the node's coordinator registry and the
// hub's checkpoint profile, written together, with the node's own digest and no restart.
func fleetBench(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(fleetcli.BenchUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	switch args[0] {
	case "stage":
		fleetBenchStage(args[1:])
	case "doctor":
		fleetBenchDoctor(args[1:])
	default:
		fmt.Fprintln(os.Stderr, fleetcli.BenchUsage)
		os.Exit(2)
	}
}

const benchStagesPath = "/api/admin/bench/stages"

// parseBenchRepo reads one --repo: name=N,provider=forge|github,repository=OWNER/REPO,clone=URL
// with optional base=BRANCH and format=sha1|sha256. Parts are split on commas, so no value may
// hold one; a clone URL with a comma in it is not supported.
func parseBenchRepo(v string) (map[string]any, error) {
	out := map[string]any{}
	keys := map[string]string{"name": "name", "provider": "provider", "repository": "repository", "clone": "cloneUrl",
		"base": "base", "format": "objectFormat"}
	for _, part := range strings.Split(v, ",") {
		k, val, ok := strings.Cut(part, "=")
		field, known := keys[k]
		if !ok || !known || val == "" {
			return nil, fmt.Errorf("--repo %q: each part is KEY=VALUE with KEY one of name, provider, repository, clone, base, format", v)
		}
		if _, dup := out[field]; dup {
			return nil, fmt.Errorf("--repo %q: %s given twice", v, k)
		}
		out[field] = val
	}
	for _, k := range []string{"name", "provider", "repository", "clone"} {
		if _, ok := out[keys[k]]; !ok {
			return nil, fmt.Errorf("--repo %q needs %s=", v, k)
		}
	}
	return out, nil
}

func fleetBenchStage(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(fleetcli.BenchUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	fs := flag.NewFlagSet("fleet bench stage", flag.ExitOnError)
	board := fs.String("board", "", "SuperPipeline board id (brd_)")
	station := fs.String("station", "", "station id the stage runs on")
	agent := fs.String("agent", "", "the SuperPipeline board agent (agt_) linked to the station's occupant")
	sourceTenant := fs.String("source-tenant", "", "the SuperPipeline tenant (tnt_); default: this workspace's other stages'")
	stageID := fs.String("stage-id", "", "the SuperPipeline stage it serves, to print its checkpointPolicy command")
	bridgeKey := fs.String("bridge-key", "", "roster key for the stage's bridge row (add)")
	checkpointRepo := fs.String("checkpoint-repo", "", "the repository the harness starts in")
	worker := fs.String("worker", "", "absolute path of the worker command on the bench host")
	launch := fs.String("launch", "", "registered-v1 (default) or grouped")
	repin := fs.Bool("repin", false, "re-pin the node registry's worker and coordinator digests to the installed bytes")
	refresh := fs.Bool("refresh", false, "re-derive the hub's pins and the node's target, changing nothing else (set)")
	keepBench := fs.Bool("keep-bench", false, "keep a card's bench after its checkpoint settles; --keep-bench=false reclaims again (the default)")
	var repos, workerArgs, env repeatable
	fs.Var(&repos, "repo", "name=N,provider=forge|github,repository=OWNER/REPO,clone=URL[,base=B][,format=sha1|sha256] (repeatable)")
	fs.Var(&workerArgs, "worker-arg", "one argument after --worker (repeatable)")
	fs.Var(&env, "env", "KEY=VALUE for the worker: PATH, LANG, LC_ALL, TZ or TERM (repeatable)")

	verb := args[0]
	switch verb {
	case "list":
		fleetGet(benchStagesPath, nil)
		return
	case "rm":
		if len(args) < 2 || args[1] == "" {
			fmt.Fprintf(os.Stderr, "rm requires a stage NAME\n\n%s\n", fleetcli.BenchUsage)
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodDelete, benchStagesPath+"/"+url.PathEscape(args[1]), nil)
		return
	case "add", "set":
	default:
		fmt.Fprintln(os.Stderr, fleetcli.BenchUsage)
		os.Exit(2)
	}
	if len(args) < 2 || strings.HasPrefix(args[1], "-") {
		fmt.Fprintf(os.Stderr, "%s requires a stage NAME\n\n%s\n", verb, fleetcli.BenchUsage)
		os.Exit(2)
	}
	name := args[1]
	_ = fs.Parse(args[2:]) // the FlagSet reports a bad flag itself

	body := map[string]any{}
	for field, v := range map[string]string{"boardId": *board, "stationId": *station, "agentId": *agent, "sourceTenantId": *sourceTenant,
		"stageId": *stageID, "checkpointRepository": *checkpointRepo} {
		if v != "" {
			body[field] = v
		}
	}
	if len(repos) > 0 {
		list := []any{}
		for _, r := range repos {
			parsed, err := parseBenchRepo(r)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			list = append(list, parsed)
		}
		body["repositories"] = list
	}
	if *worker != "" {
		w := map[string]any{"arguments": append([]string{*worker}, workerArgs...)}
		if len(env) > 0 {
			e := map[string]string{}
			for _, kv := range env {
				k, v, ok := strings.Cut(kv, "=")
				if !ok || k == "" {
					fmt.Fprintf(os.Stderr, "--env takes KEY=VALUE, got %q\n", kv)
					os.Exit(2)
				}
				e[k] = v
			}
			w["environment"] = e
		}
		if *launch != "" {
			w["launch"] = *launch
		}
		body["worker"] = w
	} else if len(workerArgs) > 0 || len(env) > 0 || *launch != "" {
		fmt.Fprintln(os.Stderr, "--worker-arg, --env and --launch describe the worker: give --worker with them")
		os.Exit(2)
	}
	if *repin {
		body["repin"] = true
	}
	// Sent only when given, so a `set` that does not name it leaves the stage's choice alone.
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "keep-bench" {
			body["keepBench"] = *keepBench
		}
	})

	if verb == "add" {
		if *bridgeKey != "" {
			body["bridgeKey"] = *bridgeKey
		}
		if *refresh {
			fmt.Fprintln(os.Stderr, "--refresh is for set; add derives everything anyway")
			os.Exit(2)
		}
		missing := []string{}
		for _, f := range []struct{ name, field string }{{"--board", "boardId"}, {"--station", "stationId"}, {"--agent", "agentId"},
			{"--repo", "repositories"}, {"--checkpoint-repo", "checkpointRepository"}, {"--worker", "worker"}} {
			if _, ok := body[f.field]; !ok {
				missing = append(missing, f.name)
			}
		}
		if len(missing) > 0 {
			fmt.Fprintf(os.Stderr, "add requires %v\n\n%s\n", missing, fleetcli.BenchUsage)
			os.Exit(2)
		}
		body["name"] = name
		fleetSkillJSON(http.MethodPost, benchStagesPath, body)
		return
	}
	if *bridgeKey != "" {
		fmt.Fprintln(os.Stderr, "--bridge-key is for add; the stage keeps its roster row (move it with fleet bridge set)")
		os.Exit(2)
	}
	if *refresh {
		body["refresh"] = true
	}
	if len(body) == 0 {
		// A PATCH with nothing in it would change nothing; say so rather than answer "done".
		fmt.Fprintf(os.Stderr, "set needs at least one field to change (or --refresh)\n\n%s\n", fleetcli.BenchUsage)
		os.Exit(2)
	}
	fleetSkillJSON(http.MethodPatch, benchStagesPath+"/"+url.PathEscape(name), body)
}

type benchDoctorReport struct {
	OK     bool `json:"ok"`
	Checks []struct {
		Check  string `json:"check"`
		OK     *bool  `json:"ok"`
		Detail string `json:"detail"`
		Next   string `json:"next"`
		Warn   bool   `json:"warn"`
	} `json:"checks"`
	Manual           []string        `json:"manual"`
	CheckpointPolicy json.RawMessage `json:"checkpointPolicy"`
}

// fleetBenchDoctor prints one line per check, PASS or FAIL with its next step, then the steps no
// verb here can take. Exit 0 when every check passed, 1 when one failed.
func fleetBenchDoctor(args []string) {
	fs := flag.NewFlagSet("fleet bench doctor", flag.ExitOnError)
	station := fs.String("station", "", "check a station with no stage yet")
	asJSON := fs.Bool("json", false, "print the hub's report as JSON")
	name := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		name, args = args[0], args[1:]
	}
	_ = fs.Parse(args) // the FlagSet reports a bad flag itself
	if (name == "") == (*station == "") {
		fmt.Fprintf(os.Stderr, "doctor takes a stage NAME or --station S\n\n%s\n", fleetcli.BenchUsage)
		os.Exit(2)
	}
	q := url.Values{}
	if name != "" {
		q.Set("stage", name)
	} else {
		q.Set("station", *station)
	}
	raw := fleetRequestBytes(http.MethodGet, "/api/admin/bench/doctor?"+q.Encode(), nil, "", 90*time.Second)
	if *asJSON {
		fmt.Println(string(raw))
		return
	}
	var report benchDoctorReport
	if err := json.Unmarshal(raw, &report); err != nil {
		fmt.Fprintf(os.Stderr, "the hub's doctor report did not parse: %v\n", err)
		os.Exit(1)
	}
	failed := renderBenchDoctor(os.Stdout, report)
	if failed {
		os.Exit(1)
	}
}

func renderBenchDoctor(w *os.File, report benchDoctorReport) bool {
	failed := false
	for _, c := range report.Checks {
		mark := "SKIP"
		if c.OK == nil && c.Warn {
			mark = "WARN"
		}
		if c.OK != nil && *c.OK {
			mark = "PASS"
		} else if c.OK != nil {
			mark, failed = "FAIL", true
		}
		fmt.Fprintf(w, "%s  %-34s %s\n", mark, c.Check, c.Detail)
		if c.Next != "" && mark != "PASS" {
			fmt.Fprintf(w, "      next: %s\n", c.Next)
		}
	}
	if len(report.Manual) > 0 {
		fmt.Fprintln(w, "\nManual steps (no fleet verb does these):")
		for _, m := range report.Manual {
			fmt.Fprintf(w, "  - %s\n", m)
		}
	}
	if len(report.CheckpointPolicy) > 0 && string(report.CheckpointPolicy) != "null" {
		var pretty bytes.Buffer
		if json.Indent(&pretty, report.CheckpointPolicy, "  ", "  ") == nil {
			fmt.Fprintf(w, "\nThe stage's checkpointPolicy for SuperPipeline:\n  %s\n", pretty.String())
		}
	}
	return failed
}
