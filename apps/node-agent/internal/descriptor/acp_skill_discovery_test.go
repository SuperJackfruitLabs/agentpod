package descriptor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDiscoverACPSkillCommandsUsesHarnessCommandMapping(t *testing.T) {
	workspace := t.TempDir()
	adapter := filepath.Join(t.TempDir(), "adapter")
	script := `#!/bin/bash
read first
if read -r -t 1 second; then
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"session/new arrived before initialize response"}}'
  exit 1
fi
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}'
read second
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"/release"},{"name":"/ignore"},{"name":"builtin"}]}}}'
`
	if err := os.WriteFile(adapter, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	names, err := discoverACPSkillCommands(context.Background(), []string{adapter}, workspace, []string{"PATH=" + os.Getenv("PATH")}, func(name string) (string, bool) {
		return strings.TrimPrefix(name, "/"), strings.HasPrefix(name, "/")
	})
	if err != nil || !reflect.DeepEqual(names, []string{"ignore", "release"}) {
		t.Fatalf("names=%q err=%v", names, err)
	}
}

func TestDiscoverACPSkillCommandsRejectsMissingNameMapping(t *testing.T) {
	_, err := discoverACPSkillCommands(context.Background(), []string{"/bin/sh"}, t.TempDir(), nil, nil)
	if err == nil || !strings.Contains(err.Error(), "command-name mapping") {
		t.Fatalf("err=%v", err)
	}
}

func TestDiscoverACPSkillCommandsRetainsAdapterStderrOnEarlyClose(t *testing.T) {
	workspace := t.TempDir()
	adapter := filepath.Join(t.TempDir(), "adapter")
	script := "#!/bin/bash\necho 'unsupported offline provider' >&2\nexit 1\n"
	if err := os.WriteFile(adapter, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	_, err := discoverACPSkillCommands(context.Background(), []string{adapter}, workspace, []string{"PATH=" + os.Getenv("PATH")}, func(name string) (string, bool) {
		return name, true
	})
	if err == nil || !strings.Contains(err.Error(), "unsupported offline provider") {
		t.Fatalf("err=%v", err)
	}
}

// The inventory bound is applied at its call site and relies on a shorter
// caller deadline dominating the 45s this function applies internally. If that
// ever stopped holding, a cold adapter start would again outlive the hub's
// request deadline, so pin the behaviour here: the probe must give up on the
// caller's schedule and report an error that wraps context.DeadlineExceeded.
func TestDiscoverACPSkillCommandsHonorsAShorterCallerDeadline(t *testing.T) {
	workspace := t.TempDir()
	adapter := filepath.Join(t.TempDir(), "adapter")
	// A cold start that never answers initialize.
	script := "#!/bin/bash\nsleep 120\n"
	if err := os.WriteFile(adapter, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := discoverACPSkillCommands(ctx, []string{adapter}, workspace, []string{"PATH=" + os.Getenv("PATH")}, func(name string) (string, bool) {
		return name, true
	})
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("probe outlived the caller's deadline")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err does not wrap context.DeadlineExceeded: %v", err)
	}
	if elapsed > 30*time.Second {
		t.Fatalf("the inner 45s bound won over the caller's %s deadline (took %s)", 300*time.Millisecond, elapsed)
	}
}
