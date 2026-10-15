package main

// `fleet skill` — the skill that ships inside this binary, so an agent that has fleet knows how
// to use it. The source is skill/SKILL.md, embedded at build time; the version it is "written
// for" is stamped at print time, so a copy on disk says which binary produced it.

import (
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed skill/SKILL.md
var skillSource string

const (
	skillName          = "agentpod-fleet"
	skillVersionMarker = "{{VERSION}}"
)

// skillText is the skill as printed and installed: the embedded source with this binary's
// version stamped in.
func skillText(version string) string {
	return strings.ReplaceAll(skillSource, skillVersionMarker, version)
}

// defaultSkillDir is where Claude Code looks for personal skills.
func defaultSkillDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot find the home directory (set HOME, or pass --dir): %w", err)
	}
	return filepath.Join(home, ".claude", "skills"), nil
}

// skillPath is the one file `skill install` owns under dir.
func skillPath(dir string) string {
	return filepath.Join(dir, skillName, "SKILL.md")
}

// installSkill writes the skill to <dir>/agentpod-fleet/SKILL.md and returns that path. It
// stages the file beside its destination and renames it into place, so a reader never sees a
// half-written skill, and it touches nothing but its own file, so running it again is a no-op.
func installSkill(dir, version string) (string, error) {
	dest := skillPath(dir)
	folder := filepath.Dir(dest)
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(folder, ".SKILL.md.staging-*")
	if err != nil {
		return "", err
	}
	staged := tmp.Name()
	cleanup := func() { _ = os.Remove(staged) }
	if _, err := tmp.WriteString(skillText(version)); err != nil {
		tmp.Close()
		cleanup()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", err
	}
	if err := os.Chmod(staged, 0o644); err != nil {
		cleanup()
		return "", err
	}
	if err := os.Rename(staged, dest); err != nil {
		cleanup()
		return "", err
	}
	return dest, nil
}

// refreshInstalledSkill re-installs the skill ONLY when one is already at dir, so an updated
// binary never leaves an older skill behind and never creates one nobody asked for. run
// performs the install (after an update it is the NEW binary, whose embedded text is the new
// one). It reports whether a refresh was attempted.
func refreshInstalledSkill(dir string, run func(dir string) error) (bool, error) {
	if _, err := os.Stat(skillPath(dir)); err != nil {
		return false, nil
	}
	return true, run(dir)
}

// fleetSkill dispatches `fleet skill [install]`.
func fleetSkill(args []string) {
	if len(args) == 0 {
		fmt.Print(skillText(version))
		return
	}
	switch args[0] {
	case "install":
		fleetSkillInstall(args[1:])
	default:
		fmt.Fprintln(os.Stderr, "usage: fleet skill [install [--dir DIR] [--json]]")
		os.Exit(2)
	}
}

func fleetSkillInstall(args []string) {
	fs := flag.NewFlagSet("skill install", flag.ExitOnError)
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "fleet skill install [--dir DIR] [--json]")
		fs.PrintDefaults()
	}
	dir := fs.String("dir", "", "the skills directory to install under (default ~/.claude/skills)")
	asJSON := fs.Bool("json", false, "print the path written as JSON")
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}
	if fs.NArg() > 0 {
		fs.Usage()
		os.Exit(2)
	}
	target := *dir
	if target == "" {
		d, err := defaultSkillDir()
		if err != nil {
			fmt.Fprintln(os.Stderr, "skill install:", err)
			os.Exit(1)
		}
		target = d
	}
	path, err := installSkill(target, version)
	if err != nil {
		fmt.Fprintln(os.Stderr, "skill install:", err)
		os.Exit(1)
	}
	if *asJSON {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"path": path})
		return
	}
	fmt.Println(path)
}
