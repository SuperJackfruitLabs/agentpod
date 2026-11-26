package benchattach

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// KnownHostsResolver names the known_hosts file the station's ssh reads the bench's host key
// from: the file the pin must go in. An error refuses the attach before anything is written.
type KnownHostsResolver func(ctx context.Context, user, host string, port int) (string, error)

// SSHKnownHosts asks ssh itself, with `ssh -G` and the options Hermes's SSH backend passes, which
// known_hosts files it reads for this bench, and answers the first (the one ssh writes to).
//
// Asking ssh, rather than working the path out, is what makes the pin hold. OpenSSH expands `~`
// from the passwd entry of the user it runs as, never from `$HOME`, and the user's own ssh_config
// can name another UserKnownHostsFile (or none) for this host. Hermes runs ssh with
// StrictHostKeyChecking=accept-new on its command line, which no config file can override, so a pin
// in a file ssh does not read is no pin: the first key that answers would be trusted. The node runs
// Hermes's ACP sessions as its own user, so `ssh -G` here resolves for the user that connects.
func SSHKnownHosts(ctx context.Context, user, host string, port int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	args := []string{"-G", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"}
	if port != 22 {
		args = append(args, "-p", strconv.Itoa(port))
	}
	out, err := exec.CommandContext(ctx, "ssh", append(args, user+"@"+host)...).Output()
	if err != nil {
		return "", fmt.Errorf("benchattach: ssh -G could not say which known_hosts ssh reads for the bench: %w", err)
	}
	return knownHostsFromConfig(out)
}

// knownHostsFromConfig reads `ssh -G` output: the first UserKnownHostsFile, refused when it is not a
// clean absolute path, when it is `none` or the null device, and when ssh would look the bench's key
// up under a HostKeyAlias (the pin names the address).
func knownHostsFromConfig(out []byte) (string, error) {
	var files []string
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch strings.ToLower(fields[0]) {
		case "hostkeyalias":
			return "", errors.New("benchattach: ssh looks the bench up under a HostKeyAlias, so a pin for its address would not be read")
		case "userknownhostsfile":
			files = fields[1:]
		}
	}
	if len(files) == 0 {
		return "", errors.New("benchattach: ssh names no UserKnownHostsFile for the bench")
	}
	f := files[0]
	if !filepath.IsAbs(f) || filepath.Clean(f) != f || f == os.DevNull {
		return "", fmt.Errorf("benchattach: ssh reads the bench's host key from %q, where no pin can be kept", f)
	}
	return f, nil
}

// knownHostsTarget checks the resolved file before anything is written: it must be absent (attach
// creates it, and the directories missing above it, and detach removes what it created) or a
// regular file. A symlink is refused: rewriting it would replace the link with a file.
func knownHostsTarget(path string) (created bool, dirs []string, err error) {
	info, err := os.Lstat(path)
	switch {
	case err == nil && !info.Mode().IsRegular():
		return false, nil, fmt.Errorf("benchattach: %s is not a regular file", path)
	case err == nil:
		return false, nil, nil
	case !os.IsNotExist(err):
		return false, nil, fmt.Errorf("benchattach: reading known_hosts: %w", err)
	}
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		info, err := os.Lstat(dir)
		if err == nil {
			if !info.IsDir() {
				return false, nil, fmt.Errorf("benchattach: %s is not a directory", dir)
			}
			break
		}
		if !os.IsNotExist(err) || dir == filepath.Dir(dir) {
			return false, nil, fmt.Errorf("benchattach: reading %s: %w", dir, err)
		}
		dirs = append([]string{dir}, dirs...)
	}
	return true, dirs, nil
}

// unpinRecord takes the attempt's pin out of the file it went into and, when attach created that
// file (and the directories above it), removes what is left empty, so known_hosts is as it was.
func unpinRecord(r record, path string) error {
	if err := unpin(path, r.StationID, r.AttemptID, r.Pinned); err != nil {
		return err
	}
	if !r.KnownHostsCreated {
		return nil
	}
	if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() && info.Size() == 0 {
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("benchattach: removing the known_hosts attach created: %w", err)
		}
	}
	for i := len(r.KnownHostsDirs) - 1; i >= 0; i-- {
		_ = os.Remove(r.KnownHostsDirs[i]) // only an empty directory goes; one ssh has since used stays
	}
	return nil
}
