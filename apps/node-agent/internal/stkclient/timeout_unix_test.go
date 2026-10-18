//go:build !windows

package stkclient

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestTimeoutReturnsErrorAndKillsChild(t *testing.T) {
	self, _ := os.Executable()
	pidfile := filepath.Join(t.TempDir(), "pid")
	c := New(self, Options{
		Timeout: 1500 * time.Millisecond,
		Env:     map[string]string{"STKCLIENT_STUB": "sleep", "STKCLIENT_PIDFILE": pidfile},
	})
	start := time.Now()
	_, err := c.Version(ctx())
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("took %v", time.Since(start))
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v", err)
	}
	b, rerr := os.ReadFile(pidfile)
	if rerr != nil {
		t.Fatalf("stub never started: %v", rerr)
	}
	pid, perr := strconv.Atoi(string(b))
	if perr != nil || pid <= 0 {
		t.Fatalf("bad pid %q", b)
	}
	if kerr := syscall.Kill(pid, 0); kerr != syscall.ESRCH {
		t.Fatalf("child %d still alive (kill -0 => %v)", pid, kerr)
	}
}
