package benchattach

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostfs"
)

// The bench's host key is pinned as one managed line in the gateway user's known_hosts, followed
// by a marker comment that names whose it is:
//
//	[100.64.0.1]:2222 ssh-ed25519 AAAA...
//	# agentpod-bench <stationID> <attemptID>
//
// It must be there before Hermes first connects: Hermes runs ssh with
// StrictHostKeyChecking=accept-new, which refuses a key that differs from a pinned one but trusts
// whatever answers first when nothing is pinned. Every other line in the file is the user's and is
// kept byte for byte.

const markerPrefix = "# agentpod-bench "

func marker(stationID, attemptID string) string { return markerPrefix + stationID + " " + attemptID }

// hostPattern is the known_hosts name ssh looks up for address: bare for port 22, [host]:port
// otherwise.
func hostPattern(address string) (host string, port int, pattern string, err error) {
	h, p, err := net.SplitHostPort(address)
	if err != nil || h == "" {
		return "", 0, "", fmt.Errorf("address %q is not host:port", address)
	}
	if _, scanErr := fmt.Sscanf(p, "%d", &port); scanErr != nil || port < 1 || port > 65535 || fmt.Sprint(port) != p {
		return "", 0, "", fmt.Errorf("address %q has no valid port", address)
	}
	if port == 22 {
		return h, port, h, nil
	}
	return h, port, "[" + h + "]:" + p, nil
}

func pinLine(address, hostKey string) (string, error) {
	_, _, pattern, err := hostPattern(address)
	if err != nil {
		return "", err
	}
	return pattern + " " + hostKey, nil
}

// pin appends the managed pair, first dropping any pair this station already had.
func pin(path, stationID, attemptID, line string) error {
	data, mode, err := readKnownHosts(path)
	if err != nil {
		return err
	}
	text := string(unmanage(data, stationID, "", ""))
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += line + "\n" + marker(stationID, attemptID) + "\n"
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("benchattach: creating %s: %w", filepath.Dir(path), err)
	}
	return hostfs.AtomicWriteFile(path, []byte(text), mode)
}

// unpin removes this attempt's marker and, when it is the line just above, the pinned line; nothing
// else.
func unpin(path, stationID, attemptID, line string) error {
	data, mode, err := readKnownHosts(path)
	if err != nil || data == nil {
		return err
	}
	out := unmanage(data, stationID, attemptID, line)
	if string(out) == string(data) {
		return nil
	}
	return hostfs.AtomicWriteFile(path, out, mode)
}

// unmanage drops each marker for stationID (and attemptID, when given) with the line before it:
// that line exactly when line is given, else any host line (a leftover from an attach that never
// finished).
func unmanage(data []byte, stationID, attemptID, line string) []byte {
	lines := strings.SplitAfter(string(data), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		fields := strings.Fields(strings.TrimPrefix(strings.TrimRight(l, "\r\n"), markerPrefix))
		mine := strings.HasPrefix(l, markerPrefix) && len(fields) == 2 && fields[0] == stationID &&
			(attemptID == "" || fields[1] == attemptID)
		if !mine {
			out = append(out, l)
			continue
		}
		if n := len(out); n > 0 && pinned(out[n-1], line) {
			out = out[:n-1]
		}
	}
	return []byte(strings.Join(out, ""))
}

func readKnownHosts(path string) ([]byte, os.FileMode, error) {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil, 0o600, nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("benchattach: reading known_hosts: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, fmt.Errorf("benchattach: reading known_hosts: %w", err)
	}
	return data, info.Mode().Perm(), nil
}

func pinned(l, line string) bool {
	l = strings.TrimRight(l, "\r\n")
	if line != "" {
		return l == line
	}
	return strings.TrimSpace(l) != "" && !strings.HasPrefix(strings.TrimSpace(l), "#")
}
