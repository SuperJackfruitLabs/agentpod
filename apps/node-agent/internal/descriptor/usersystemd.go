package descriptor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// userRuntimeBase is where systemd keeps each user's runtime directory
// (/run/user/<uid>). A variable so tests can point it at a temp dir.
var userRuntimeBase = "/run/user"

// userSystemctl builds a `systemctl --user <args…>` command that can reach
// the user's service manager from a system service.
//
// `systemctl --user` finds the user manager through XDG_RUNTIME_DIR and the
// session bus. A login shell has both; the node agent, running as a system
// service, has neither, so every `--user` call fails as though the unit did
// not exist. On guild (2026-09-26) that made a Hermes restart kill the
// gateway's process — which its unit respawned — and then launch a second
// `gateway run --replace` beside it; the unit crash-looped on "Gateway
// already running". When the variables are unset and this user's runtime dir
// exists, they are filled in from it; values the caller already has are kept.
func userSystemctl(args ...string) *exec.Cmd {
	cmd := exec.Command("systemctl", append([]string{"--user"}, args...)...)
	cmd.Env = userSessionEnv(os.Environ())
	return cmd
}

func userSessionEnv(env []string) []string {
	dir := filepath.Join(userRuntimeBase, fmt.Sprint(os.Getuid()))
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return env
	}
	runtime := os.Getenv("XDG_RUNTIME_DIR")
	if runtime == "" {
		runtime = dir
		env = append(env, "XDG_RUNTIME_DIR="+dir)
	}
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		if _, err := os.Stat(filepath.Join(runtime, "bus")); err == nil {
			env = append(env, "DBUS_SESSION_BUS_ADDRESS=unix:path="+filepath.Join(runtime, "bus"))
		}
	}
	return env
}
