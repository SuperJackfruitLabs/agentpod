package fleetreport

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const report = `{"agent":"@agent_echo:hs","roomId":"!r:hs","reader":"@me:hs","at":1,"event":{"type":"step","title":"Read notes","completed":0,"total":1}}`

func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "fr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func TestFrameWrapsAReportUnchanged(t *testing.T) {
	frame, err := Frame([]byte(report + "\n"))
	if err != nil {
		t.Fatalf("Frame: %v", err)
	}
	var got struct {
		Type   string          `json:"type"`
		Report json.RawMessage `json:"report"`
	}
	if err := json.Unmarshal(frame, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Type != "fleet.report" {
		t.Errorf("type = %q, want fleet.report", got.Type)
	}
	if string(got.Report) != report {
		t.Errorf("report changed in transit:\n got %s\nwant %s", got.Report, report)
	}
}

func TestFrameRefusesTheObvious(t *testing.T) {
	// The hub validates against the contract; the node refuses what could
	// never be matched to a station, so a plugin hears "no" on its own socket.
	cases := map[string]string{
		"not json":       `turn-started`,
		"not an object":  `["turn-started"]`,
		"no agent":       `{"roomId":"!r:hs","reader":"@me:hs","event":{"type":"turn-started"}}`,
		"empty agent":    `{"agent":"","roomId":"!r:hs","reader":"@me:hs","event":{"type":"turn-started"}}`,
		"no room":        `{"agent":"@a:hs","reader":"@me:hs","event":{"type":"turn-started"}}`,
		"no reader":      `{"agent":"@a:hs","roomId":"!r:hs","event":{"type":"turn-started"}}`,
		"no event":       `{"agent":"@a:hs","roomId":"!r:hs","reader":"@me:hs"}`,
		"event no type":  `{"agent":"@a:hs","roomId":"!r:hs","reader":"@me:hs","event":{}}`,
		"agent a number": `{"agent":7,"roomId":"!r:hs","reader":"@me:hs","event":{"type":"turn-started"}}`,
	}
	for name, line := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Frame([]byte(line)); err == nil {
				t.Errorf("Frame(%s) accepted it", line)
			}
		})
	}
}

func send(t *testing.T, path, line string) string {
	t.Helper()
	c, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write([]byte(line + "\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	reply, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	return strings.TrimSpace(reply)
}

func startIntake(t *testing.T, out chan []byte) string {
	t.Helper()
	path := filepath.Join(shortDir(t), "fleet.sock")
	in, err := Listen(path, out)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); in.Close() })
	go in.Serve(ctx)
	return path
}

func TestIntakeForwardsAReportAndSaysOK(t *testing.T) {
	out := make(chan []byte, 4)
	path := startIntake(t, out)
	if reply := send(t, path, report); reply != "ok" {
		t.Fatalf("reply = %q, want ok", reply)
	}
	select {
	case frame := <-out:
		if !strings.Contains(string(frame), `"type":"fleet.report"`) {
			t.Errorf("frame = %s", frame)
		}
	case <-time.After(time.Second):
		t.Fatal("nothing forwarded")
	}
}

func TestIntakeRefusesMoreThanACardEverShows(t *testing.T) {
	out := make(chan []byte, 4)
	path := startIntake(t, out)
	big := strings.Replace(report, "Read notes", strings.Repeat("x", MaxLineBytes), 1)
	if reply := send(t, path, big); !strings.HasPrefix(reply, "error: ") {
		t.Fatalf("reply = %q, want an error line", reply)
	}
	select {
	case frame := <-out:
		t.Fatalf("forwarded an oversized report: %s", frame)
	default:
	}
}

func TestSocketIsTheOwnersAlone(t *testing.T) {
	path := startIntake(t, make(chan []byte, 1))
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("socket mode = %o, want 600", perm)
	}
}

func TestDefaultSocketPath(t *testing.T) {
	t.Setenv(SocketEnv, "")
	t.Setenv("HOME", "/root")
	got, err := DefaultSocketPath()
	if err != nil {
		t.Fatal(err)
	}
	if got != "/root/.agentpod/fleet.sock" {
		t.Errorf("DefaultSocketPath = %q", got)
	}
	t.Setenv(SocketEnv, "/run/f.sock")
	if got, _ := DefaultSocketPath(); got != "/run/f.sock" {
		t.Errorf("override = %q", got)
	}
}

// The outbox to the hub is shared with turn errors. A chatty fleet during a
// hub outage must not fill it: fleet frames stop at half, and the rest is
// left for the reports a room shows.
func TestForwardLeavesHalfTheOutboxForTurnErrors(t *testing.T) {
	in := make(chan []byte, 16)
	out := make(chan []byte, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { Forward(ctx, in, out); close(done) }()

	for i := 0; i < 10; i++ {
		in <- []byte("f")
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(in) > 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(in) != 0 {
		t.Fatalf("forwarder did not drain its input")
	}
	// Room left for turn errors: half the outbox.
	if got := len(out); got != cap(out)/2 {
		t.Errorf("fleet frames in the outbox = %d, want %d", got, cap(out)/2)
	}
	cancel()
	<-done
}
