package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// stubJournalctl installs a journalctl that records its arguments and prints two lines; with
// -f it then waits until killed, like the real follow.
func stubJournalctl(t *testing.T) (argsFile string) {
	t.Helper()
	dir := t.TempDir()
	argsFile = filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" > " + argsFile + "\necho 'salaam started'\necho 'listening on operator.sock'\n" +
		"for a in \"$@\"; do [ \"$a\" = -f ] && exec sleep 30; done\nexit 0\n"
	bin := filepath.Join(dir, "journalctl")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := salaamJournalctl
	salaamJournalctl = bin
	t.Cleanup(func() { salaamJournalctl = orig })
	return argsFile
}

func salaamForLogs(t *testing.T) (Descriptor, string) {
	t.Helper()
	base, _ := filepath.EvalSymlinks(t.TempDir())
	ws := filepath.Join(base, "workspace")
	_ = os.Mkdir(ws, 0o700)
	bin, _ := os.Executable()
	return NewSalaamFrom(SalaamConfig{Binary: bin, StateDir: filepath.Join(base, "state"), Workspace: ws}), salaam.StationKey(ws)
}

func TestSalaamTailLogsReadsTheDaemonJournalLast500(t *testing.T) {
	argsFile := stubJournalctl(t)
	d, key := salaamForLogs(t)
	var got strings.Builder
	if err := d.TailLogs(context.Background(), key, false, func(b []byte) error { got.Write(b); return nil }); err != nil {
		t.Fatal(err)
	}
	if got.String() != "salaam started\nlistening on operator.sock\n" {
		t.Fatalf("journal lines not streamed: %q", got.String())
	}
	args, _ := os.ReadFile(argsFile)
	if strings.TrimSpace(string(args)) != "--user -u salaam -n 500 -o cat --no-pager" {
		t.Fatalf("wrong journal query: %q", args)
	}
}

func TestSalaamLauncherHostLogsTailTheUnitLogFileNotTheUserJournal(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	ws := filepath.Join(base, "workspace")
	_ = os.Mkdir(ws, 0o700)
	key := salaam.StationKey(ws)
	id := key[len("salaam:"):]
	oldRoot, oldDir, oldTail := salaamLauncherRoot, salaamLauncherLogDir, salaamTail
	t.Cleanup(func() { salaamLauncherRoot, salaamLauncherLogDir, salaamTail = oldRoot, oldDir, oldTail })
	salaamLauncherRoot, salaamLauncherLogDir = filepath.Join(base, "stations"), filepath.Join(base, "log")
	argsFile := filepath.Join(base, "args")
	stub := filepath.Join(base, "tail")
	_ = os.WriteFile(stub, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" > "+argsFile+"\necho 'host ready'\n"), 0o755)
	salaamTail = stub
	journal := stubJournalctl(t)
	bin, _ := os.Executable()
	d := NewSalaamFrom(SalaamConfig{Binary: bin, StateDir: filepath.Join(base, "state"), Workspace: ws, Manifest: filepath.Join(salaamLauncherRoot, id, "host.json")})
	var got strings.Builder
	if err := d.TailLogs(context.Background(), key, false, func(b []byte) error { got.Write(b); return nil }); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(argsFile)
	if got.String() != "host ready\n" || strings.TrimSpace(string(args)) != "-n 500 "+filepath.Join(salaamLauncherLogDir, id+".log") {
		t.Fatalf("launcher log not tailed: out=%q args=%q", got.String(), args)
	}
	if _, err := os.Stat(journal); err == nil {
		t.Fatal("the user journal was queried for a launcher host")
	}
}

func TestSalaamTailLogsFollowsUntilCancelled(t *testing.T) {
	argsFile := stubJournalctl(t)
	d, key := salaamForLogs(t)
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	lines := 0
	done := make(chan error, 1)
	go func() {
		done <- d.TailLogs(ctx, key, true, func([]byte) error { mu.Lock(); lines++; mu.Unlock(); return nil })
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := lines
		mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("follow did not stream the backlog: %d lines", n)
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case err := <-done:
		t.Fatalf("follow ended on its own: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancelled follow returned an error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("follow did not stop on cancel")
	}
	args, _ := os.ReadFile(argsFile)
	if !strings.HasSuffix(strings.TrimSpace(string(args)), " -f") {
		t.Fatalf("follow not asked of journalctl: %q", args)
	}
}

func TestSalaamTailLogsRefusesAnotherStation(t *testing.T) {
	stubJournalctl(t)
	d, _ := salaamForLogs(t)
	if err := d.TailLogs(context.Background(), "salaam:0000000000000000", false, func([]byte) error { return nil }); err == nil {
		t.Fatal("tailed logs for a station this node does not hold")
	}
}
