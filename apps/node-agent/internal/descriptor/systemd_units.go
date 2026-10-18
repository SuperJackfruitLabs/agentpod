package descriptor

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// What the forge API wiring needs to know about the harnesses a systemd user unit starts. The
// wiring itself lives in internal/forgeapi; this file only names units, so the descriptors stay
// free of it.

var unitSafeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$`)

// hermesProfileUnit is the per-profile Hermes gateway unit for a station key, or "" for a key that
// has none. The root "hermes" station is not one: its gateway may serve several stations, so one
// station's environment cannot be given to it. OpenClaw's single gateway is likewise shared by
// all its agents and is not named here.
func hermesProfileUnit(key string) string {
	name, ok := strings.CutPrefix(key, "hermes:")
	if !ok || !unitSafeName.MatchString(name) {
		return ""
	}
	return hermesUnitName(key)
}

// HarnessSystemdUnits returns the systemd user units that start the harness of the station with
// this key, when such a unit is installed.
func HarnessSystemdUnits(key string) []string {
	unit := hermesProfileUnit(key)
	if unit == "" || !hermesUnitKnown(unit) {
		return nil
	}
	return []string{unit}
}

// UserUnitActive reports whether a systemd user unit is active.
func UserUnitActive(unit string) bool {
	out, err := userSystemctl("is-active", unit).Output()
	return err == nil && strings.TrimSpace(string(out)) == "active"
}

// UserDaemonReload tells the user manager that unit files changed.
func UserDaemonReload() error { return userSystemctl("daemon-reload").Run() }

// UserUnitDropInDir is the drop-in directory of a user unit of the node's own user.
func UserUnitDropInDir(unit string) string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = "/root"
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "systemd", "user", unit+".d")
}
