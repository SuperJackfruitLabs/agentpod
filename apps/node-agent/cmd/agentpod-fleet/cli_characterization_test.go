package main

// Characterization of what fleet prints and how it exits for every help path, pinned before the
// command reference and its helpers move out of package main (docs/contributor/modularity-plan.md,
// Phase 5). The test binary re-runs itself as fleet (TestMain below), so this is the real main().
// No credential exists and the hub is an address nothing listens on, so no path reaches a network.
//
// Regenerate the golden file with:
//
//	go test ./cmd/agentpod-fleet -run TestCLICharacterization -update-cli-golden

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

var updateCLIGolden = flag.Bool("update-cli-golden", false, "rewrite testdata/cli.golden.txt")

const cliCharacterizationEnv = "FLEET_CLI_CHARACTERIZATION_ARGS"

func TestMain(m *testing.M) {
	if args, ok := os.LookupEnv(cliCharacterizationEnv); ok {
		os.Args = append([]string{"agentpod-fleet"}, strings.Split(args, "\x1f")...)
		if args == "" {
			os.Args = os.Args[:1]
		}
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// runFleet runs the real main() with args in a child process and reports what it printed.
func runFleet(t *testing.T, home string, args ...string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(context.Background(), self)
	env := []string{}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "AGENTPOD_") && !strings.HasPrefix(kv, "BROWSER=") {
			env = append(env, kv)
		}
	}
	cmd.Env = append(env, cliCharacterizationEnv+"="+strings.Join(args, "\x1f"), "HOME="+home,
		"XDG_CONFIG_HOME="+filepath.Join(home, ".config"), "AGENTPOD_HUB=http://127.0.0.1:9", "BROWSER=none")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	code := 0
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatalf("fleet %v: %v", args, err)
		}
		code = exit.ExitCode()
	}
	out := fmt.Sprintf("$ fleet %s\nexit %d\n--- stdout\n%s--- stderr\n%s", strings.Join(args, " "), code, stdout.String(), stderr.String())
	out = strings.ReplaceAll(out, home, "$HOME")
	return strings.ReplaceAll(out, runtime.GOOS+"/"+runtime.GOARCH, "$GOOS/$GOARCH")
}

func TestCLICharacterization(t *testing.T) {
	home := t.TempDir()
	// Every verb and subverb the committed reference page documents.
	page, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs-site", "src", "content", "docs", "reference", "fleet.md"))
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, m := range regexp.MustCompile(`(?m)^##+ fleet ([a-z][a-z -]*)$`).FindAllStringSubmatch(string(page), -1) {
		paths = append(paths, m[1])
	}
	if len(paths) < 40 {
		t.Fatalf("parsed %d commands from the reference page", len(paths))
	}
	var b strings.Builder
	write := func(args ...string) { b.WriteString(runFleet(t, home, args...) + "\n") }
	write()
	write("help")
	write("-h")
	write("--help")
	write("version")
	write("bogus")
	for _, p := range paths {
		if p == "help" || p == "version" {
			continue
		}
		write(append(strings.Fields(p), "-h")...)
	}
	got := b.String()
	golden := filepath.Join("testdata", "cli.golden.txt")
	if *updateCLIGolden {
		if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("%v (run with -update-cli-golden to create it)", err)
	}
	if string(want) != got {
		t.Errorf("fleet's help output changed.\n--- got ---\n%s", got)
	}
}
