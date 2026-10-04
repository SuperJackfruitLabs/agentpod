package otelenv

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"strings"
)

// serviceUnit is the systemd unit name both service templates install.
const serviceUnit = "agentpod-node.service"

// ErrNotService means the running process is not the agentpod-node systemd service — a
// container or fixed-image node, or a hand-started `apn run` (tmux, nohup). Nothing would
// read the env file there, and nothing would restart the node after it exits, so the
// gateway telemetry verbs must refuse rather than write and exit.
var ErrNotService = errors.New("node is not running under the agentpod-node systemd service " +
	"(container or fixed-image node, or a hand-started `apn run`); configure telemetry in the image/substrate " +
	"or run the node with `apn service install`")

var userManager = regexp.MustCompile(`^user@\d+\.service$`)

// ServicePathFromCgroup decides, from the content of /proc/self/cgroup (cgroup v2 "0::/..."
// or v1 "N:controllers:/..." lines), whether this process is the agentpod-node systemd
// service and which otel.env its unit reads: the user path when the unit runs under a user
// manager (user@<uid>.service), the system path otherwise — whatever uid the process has,
// since a system unit may set User=. Anything else is ErrNotService.
func ServicePathFromCgroup(cgroup, home string) (string, error) {
	for _, line := range strings.Split(cgroup, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), ":", 3)
		if len(parts) != 3 {
			continue
		}
		elems := strings.Split(strings.TrimRight(parts[2], "/"), "/")
		if elems[len(elems)-1] != serviceUnit {
			continue
		}
		for _, e := range elems {
			if userManager.MatchString(e) {
				if home == "" {
					return "", errors.New("agentpod-node runs as a systemd user service but the home directory is unknown")
				}
				return UserPath(home), nil
			}
		}
		return SystemPath, nil
	}
	return "", ErrNotService
}

// DaemonPath is the otel.env path for the running node-agent daemon (the gateway telemetry
// verbs): ErrUnsupported off Linux, ErrNotService unless this process is the systemd unit.
func DaemonPath() (string, error) {
	home, _ := os.UserHomeDir()
	return daemonPath(runtime.GOOS, os.ReadFile, home)
}

func daemonPath(goos string, readFile func(string) ([]byte, error), home string) (string, error) {
	if goos != "linux" {
		return "", ErrUnsupported
	}
	b, err := readFile("/proc/self/cgroup")
	if err != nil {
		return "", fmt.Errorf("%w (reading /proc/self/cgroup: %v)", ErrNotService, err)
	}
	return ServicePathFromCgroup(string(b), home)
}
