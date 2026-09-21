package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
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
