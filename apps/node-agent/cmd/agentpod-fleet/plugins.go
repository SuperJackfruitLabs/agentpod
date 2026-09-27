package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
)

const pluginsUsage = `usage:
  fleet plugins plan --station ID --action enable|disable
  fleet plugins show --station ID --operation ID
  fleet plugins inspect --station ID --operation ID
  fleet plugins apply --station ID --operation ID --plan-digest SHA256
  fleet plugins history --station ID
  fleet plugins inventory --station ID`

// fleetPlugins drives the Console's plugin management (#553) from a shell: the
// node plans, you read the plan, and apply sends only the digest you reviewed.
// Nothing here restarts a station.
func fleetPlugins(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, pluginsUsage)
		os.Exit(2)
	}
	fs := flag.NewFlagSet("fleet plugins", flag.ExitOnError)
	station := fs.String("station", "", "station ID")
	action := fs.String("action", "", "enable or disable")
	operation := fs.String("operation", "", "operation ID")
	planDigest := fs.String("plan-digest", "", "reviewed plan digest")
	fs.Parse(args[1:])
	if *station == "" || fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "plugin commands require --station ID")
		os.Exit(2)
	}
	stationPath := "/api/stations/" + url.PathEscape(*station)
	base := stationPath + "/plugins"
	needOperation := func() string {
		if *operation == "" {
			fmt.Fprintf(os.Stderr, "%s requires --operation ID\n", args[0])
			os.Exit(2)
		}
		return base + "/operations/" + url.PathEscape(*operation)
	}
	switch args[0] {
	case "plan":
		if *action != "enable" && *action != "disable" {
			fmt.Fprintln(os.Stderr, "plan requires --action enable|disable")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"/plan", map[string]string{"requestId": randomUUID(), "action": *action})
	case "show":
		fleetGet(needOperation(), nil)
	case "inspect":
		fleetSkillJSON(http.MethodPost, needOperation()+"/inspect", map[string]string{})
	case "apply":
		path := needOperation()
		if *planDigest == "" {
			fmt.Fprintln(os.Stderr, "apply requires --plan-digest SHA256")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, path+"/apply", map[string]string{"planDigest": *planDigest})
	case "history":
		fleetGet(base+"/operations", nil)
	case "inventory":
		fleetSkillJSON(http.MethodPost, stationPath+"/skills/inventory", map[string]string{})
	default:
		fmt.Fprintln(os.Stderr, pluginsUsage)
		os.Exit(2)
	}
}
