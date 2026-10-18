package forgeapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
)

// SystemLifecycle is the real Lifecycle: systemctl and userdel, and file removal limited to the
// directories a station instance owns. It only acts on names of the shape the node makes
// (instanceNameRE), whatever it is asked.
type SystemLifecycle struct {
	// UnitDir is where the units live; default /etc/systemd/system.
	UnitDir string
	// Roots are the directories a removed tree may sit directly under (state, config, runtime).
	Roots []string

	run        func(ctx context.Context, name string, args ...string) error
	lookupUser func(string) error
}

const defaultUnitDir = "/etc/systemd/system"

func (l *SystemLifecycle) unitDir() string {
	if l.UnitDir != "" {
		return l.UnitDir
	}
	return defaultUnitDir
}

func (l *SystemLifecycle) exec(ctx context.Context, name string, args ...string) error {
	if l.run != nil {
		return l.run(ctx, name, args...)
	}
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, clean(out.String()))
	}
	return nil
}

var unitUserRE = regexp.MustCompile(`^stk-[a-z0-9-]{1,12}-[0-9a-f]{6,14}$`)

func checkInstanceName(kind, name string) error {
	if !unitUserRE.MatchString(name) {
		return fmt.Errorf("refusing to touch %s %q: not an instance this node made", kind, name)
	}
	return nil
}

func (l *SystemLifecycle) unitFile(unit string) string {
	return filepath.Join(l.unitDir(), unit+".service")
}

func (l *SystemLifecycle) EnableNow(ctx context.Context, unit string) error {
	if err := checkInstanceName("unit", unit); err != nil {
		return err
	}
	if err := l.exec(ctx, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	return l.exec(ctx, "systemctl", "enable", "--now", unit+".service")
}

func (l *SystemLifecycle) StopDisable(ctx context.Context, unit string) error {
	if err := checkInstanceName("unit", unit); err != nil {
		return err
	}
	if _, err := os.Stat(l.unitFile(unit)); errors.Is(err, os.ErrNotExist) {
		return nil // never installed, or already removed
	}
	return l.exec(ctx, "systemctl", "disable", "--now", unit+".service")
}

func (l *SystemLifecycle) RemoveUnit(ctx context.Context, unit string) error {
	if err := checkInstanceName("unit", unit); err != nil {
		return err
	}
	if err := os.Remove(l.unitFile(unit)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return l.exec(ctx, "systemctl", "daemon-reload")
}

func (l *SystemLifecycle) RemoveUser(ctx context.Context, name string) error {
	if err := checkInstanceName("user", name); err != nil {
		return err
	}
	lookup := l.lookupUser
	if lookup == nil {
		lookup = func(n string) error { _, err := user.Lookup(n); return err }
	}
	if err := lookup(name); err != nil {
		var unknown user.UnknownUserError
		if errors.As(err, &unknown) {
			return nil
		}
		return err
	}
	return l.exec(ctx, "userdel", name)
}

func (l *SystemLifecycle) RemoveTree(_ context.Context, path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fmt.Errorf("refusing to remove %q: not a clean absolute path", path)
	}
	// The tree is <root>/<name> (state, runtime) or <root>/<name>/<file's dir> never deeper.
	base := filepath.Base(path)
	if err := checkInstanceName("directory", base); err != nil {
		return err
	}
	parent := filepath.Dir(path)
	for _, r := range l.Roots {
		if filepath.Clean(r) == parent {
			return os.RemoveAll(path)
		}
	}
	return fmt.Errorf("refusing to remove %q: not under a directory the node creates instances in", path)
}
