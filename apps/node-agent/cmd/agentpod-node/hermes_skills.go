package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// Registering the managed directory in a profile's skills.external_dirs is the
// step that makes a published skill visible to Hermes. It is deliberately an
// operator action on the host rather than a remote one: it edits a file the
// operator owns, in a profile they run, and publishing skills must never carry
// it as a side effect.
//
// The command shows the exact document it would write before writing anything,
// and unregister restores what registration changed.
func hermesSkillsCmd(args []string, out, errOut io.Writer) int {
	if maybeShowHelp(out, "hermes-skills", args) {
		return 0
	}
	usage := "usage: apn hermes-skills <status|register|unregister> --profile NAME [--apply]"
	if len(args) == 0 {
		fmt.Fprintln(errOut, usage)
		return 2
	}
	action := args[0]
	profile, apply := "", false
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "--profile":
			if i+1 >= len(args) {
				fmt.Fprintln(errOut, "--profile needs a profile name")
				return 2
			}
			i++
			profile = args[i]
		case "--apply":
			apply = true
		default:
			fmt.Fprintf(errOut, "unknown argument: %q\n", args[i])
			fmt.Fprintln(errOut, usage)
			return 2
		}
	}
	if profile == "" || strings.ContainsAny(profile, "/\\ ") {
		fmt.Fprintln(errOut, "--profile must name one Hermes profile")
		return 2
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(errOut, "cannot resolve the home directory:", err)
		return 1
	}
	configPath := filepath.Join(home, ".hermes", "profiles", profile, "config.yaml")
	entry := "managed-skills"

	switch action {
	case "status":
		// Status asks the same question registration would, without writing.
		plan, _, err := skills.PlanExternalDirs(configPath, entry, "register")
		if err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		if plan.Present {
			fmt.Fprintf(out, "%s: %s is registered in skills.external_dirs\n", profile, entry)
		} else {
			fmt.Fprintf(out, "%s: %s is not registered; published skills are inert until it is\n", profile, entry)
		}
		fmt.Fprintln(out, "config:", configPath)
		return 0
	case "register", "unregister":
		plan, proposed, err := skills.PlanExternalDirs(configPath, entry, action)
		if err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		if plan.NoOp {
			fmt.Fprintf(out, "%s: nothing to do, %s is already %s\n", profile, entry,
				map[bool]string{true: "registered", false: "absent"}[plan.Present])
			return 0
		}
		if !apply {
			// Review before writing: the operator sees the document, not a
			// description of it.
			fmt.Fprintf(out, "%s would change %s\n\n", action, configPath)
			fmt.Fprint(out, diffLines(readOrEmpty(configPath), string(proposed)))
			fmt.Fprintf(out, "\nrerun with --apply to write this\n")
			return 0
		}
		if err := skills.ApplyExternalDirs(plan, proposed); err != nil {
			fmt.Fprintln(errOut, err)
			return 1
		}
		fmt.Fprintf(out, "%s: %s %sed in skills.external_dirs\n", profile, entry, action)
		fmt.Fprintln(out, "a running Hermes gateway for this profile reads its configuration at start; restart it to pick this up")
		return 0
	default:
		fmt.Fprintf(errOut, "unknown hermes-skills action: %q\n", action)
		fmt.Fprintln(errOut, usage)
		return 2
	}
}

func readOrEmpty(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

// diffLines prints only the lines that differ, with context, so an operator
// reviewing a configuration change sees the change rather than the file.
func diffLines(before, after string) string {
	oldLines, newLines := strings.Split(before, "\n"), strings.Split(after, "\n")
	var b strings.Builder
	i, j := 0, 0
	for i < len(oldLines) || j < len(newLines) {
		switch {
		case i < len(oldLines) && j < len(newLines) && oldLines[i] == newLines[j]:
			i++
			j++
		case j < len(newLines) && (i >= len(oldLines) || !contains(oldLines[i:], newLines[j])):
			fmt.Fprintf(&b, "  + %s\n", newLines[j])
			j++
		case i < len(oldLines):
			fmt.Fprintf(&b, "  - %s\n", oldLines[i])
			i++
		default:
			j++
		}
	}
	return b.String()
}

func contains(lines []string, want string) bool {
	for _, line := range lines {
		if line == want {
			return true
		}
	}
	return false
}
