package main

// Characterization of what apn prints and how it exits for every help path, pinned before the
// command table and the reference move out of package main (docs/contributor/modularity-plan.md,
// Phase 5). The test binary re-runs itself as apn (TestMain below), so this is the real main().
//
// Regenerate the golden file with:
//
//	go test ./cmd/agentpod-node -run TestCLICharacterization -update-cli-golden

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

const cliCharacterizationEnv = "APN_CLI_CHARACTERIZATION_ARGS"

func TestMain(m *testing.M) {
	if args, ok := os.LookupEnv(cliCharacterizationEnv); ok {
		os.Args = append([]string{"agentpod-node"}, strings.Split(args, "\x1f")...)
		if args == "" {
			os.Args = os.Args[:1]
		}
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// runApn runs the real main() with args in a child process and reports what it printed.
func runApn(t *testing.T, home string, args ...string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(context.Background(), self)
	cmd.Env = append(os.Environ(), cliCharacterizationEnv+"="+strings.Join(args, "\x1f"), "HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, ".config"))
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	code := 0
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatalf("apn %v: %v", args, err)
		}
		code = exit.ExitCode()
	}
	out := fmt.Sprintf("$ apn %s\nexit %d\n--- stdout\n%s--- stderr\n%s", strings.Join(args, " "), code, stdout.String(), stderr.String())
	out = strings.ReplaceAll(out, home, "$HOME")
	return strings.ReplaceAll(out, runtime.GOOS+"/"+runtime.GOARCH, "$GOOS/$GOARCH")
}

func TestCLICharacterization(t *testing.T) {
	home := t.TempDir()
	// Every command main.go dispatches, read the way the docs check reads it.
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	seen := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\tcase "([a-z][a-z0-9-]*)"`).FindAllStringSubmatch(string(src), -1) {
		if !seen[m[1]] && m[1] != "salaam-station-files-v1" {
			seen[m[1]] = true
			names = append(names, m[1])
		}
	}
	if len(names) < 10 {
		t.Fatalf("parsed %d commands from apn help", len(names))
	}
	var b strings.Builder
	write := func(args ...string) { b.WriteString(runApn(t, home, args...) + "\n") }
	write()
	write("help")
	write("-h")
	write("--help")
	write("version")
	write("node")
	write("node", "status", "-h")
	write("bogus")
	write("statsu")
	write("help", "bogus")
	for _, n := range names {
		write("help", n)
		write(n, "-h")
	}
	got := b.String()
	golden := filepath.Join("testdata", "cli.golden.txt")
	if *updateCLIGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
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
		t.Errorf("apn's help output changed.\n--- got ---\n%s", got)
	}
}
