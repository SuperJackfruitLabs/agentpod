package turnerror

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

// shortDir returns a temp dir whose socket path fits sun_path (104 bytes on
// macOS). t.TempDir() under /var/folders is often too long already.
func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "te")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func TestFrameWrapsAReportUnchanged(t *testing.T) {
	line := []byte(`{"harnessSessionKey":"agent:krishna:main","error":{"message":"quota","provider":"kimi-coding"}}`)
	frame, err := Frame(line)
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
	if got.Type != "turn.error" {
		t.Errorf("type = %q, want turn.error", got.Type)
	}
	if string(got.Report) != string(line) {
		t.Errorf("report changed in transit:\n got %s\nwant %s", got.Report, line)
	}
}

// A plugin says a run it reported ended well after all — the fallback
// answered, or chose silence (krishna, 2026-09-26 08:56). No error to carry.
func TestFrameCarriesAResolutionWithoutAnError(t *testing.T) {
	for _, r := range []string{"answered", "silent"} {
		line := []byte(`{"harnessSessionKey":"agent:krishna:main","resolution":"` + r + `"}`)
		if _, err := Frame(line); err != nil {
			t.Errorf("resolution %q refused: %v", r, err)
		}
	}
	if _, err := Frame([]byte(`{"harnessSessionKey":"k","resolution":"maybe"}`)); err == nil {
		t.Error("an unknown resolution was accepted")
	}
}

func TestFrameRefusesWhatTheHubWouldRefuse(t *testing.T) {
	// The hub validates properly; the node refuses the obvious so a plugin
	// hears "no" on its own socket instead of in a hub log it cannot read.
	cases := map[string]string{
		"not json":         `quota`,
		"not an object":    `["quota"]`,
		"no error":         `{"harnessSessionKey":"k"}`,
		"no message":       `{"harnessSessionKey":"k","error":{}}`,
		"empty message":    `{"harnessSessionKey":"k","error":{"message":""}}`,
		"no key to match":  `{"error":{"message":"quota"}}`,
		"empty key":        `{"harnessSessionKey":"","error":{"message":"quota"}}`,
		"key not a string": `{"acpSessionId":7,"error":{"message":"quota"}}`,
	}
	for name, line := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Frame([]byte(line)); err == nil {
				t.Errorf("Frame(%s) accepted it", line)
			}
		})
	}
}

// send writes one line to the socket and returns the node's one-line answer.
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

func startIntake(t *testing.T, out chan []byte) (*Intake, string) {
	t.Helper()
	path := filepath.Join(shortDir(t), "turn-errors.sock")
	in, err := Listen(path, out)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); in.Close() })
	go in.Serve(ctx)
	return in, path
}

func TestIntakeForwardsAReportAndSaysOK(t *testing.T) {
	out := make(chan []byte, 4)
	_, path := startIntake(t, out)

	reply := send(t, path, `{"harnessSessionKey":"agent:krishna:main","error":{"message":"quota"}}`)
	if reply != "ok" {
		t.Fatalf("reply = %q, want ok", reply)
	}
	select {
	case frame := <-out:
		if !strings.Contains(string(frame), `"type":"turn.error"`) {
			t.Errorf("frame = %s", frame)
		}
	case <-time.After(time.Second):
		t.Fatal("nothing forwarded")
	}
}

func TestIntakeTellsThePluginWhatWasWrong(t *testing.T) {
	out := make(chan []byte, 4)
	_, path := startIntake(t, out)

	reply := send(t, path, `{"error":{"message":"quota"}}`)
	if !strings.HasPrefix(reply, "error: ") {
		t.Fatalf("reply = %q, want an error line", reply)
	}
	select {
	case frame := <-out:
		t.Fatalf("forwarded a refused report: %s", frame)
	default:
	}
}

func TestIntakeRefusesAnOversizedLine(t *testing.T) {
	out := make(chan []byte, 4)
	_, path := startIntake(t, out)

	big := `{"harnessSessionKey":"k","error":{"message":"` + strings.Repeat("x", MaxLineBytes) + `"}}`
	reply := send(t, path, big)
	if !strings.HasPrefix(reply, "error: ") {
		t.Fatalf("reply = %q, want an error line", reply)
	}
}

func TestIntakeSaysBusyRatherThanBlockingWhenTheQueueIsFull(t *testing.T) {
	// The queue drains into the hub connection. A node that has been offline
	// for an hour must not hang every plugin that reports into it.
	out := make(chan []byte, 1)
	_, path := startIntake(t, out)

	line := `{"harnessSessionKey":"k","error":{"message":"quota"}}`
	if r := send(t, path, line); r != "ok" {
		t.Fatalf("first reply = %q", r)
	}
	if r := send(t, path, line); !strings.HasPrefix(r, "error: ") {
		t.Fatalf("second reply = %q, want busy", r)
	}
}

func TestSocketIsTheOwnersAlone(t *testing.T) {
	// Anyone who can write here can put words in an agent's room.
	out := make(chan []byte, 1)
	_, path := startIntake(t, out)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("socket mode = %o, want 600", perm)
	}
}

func TestListenReplacesAStaleSocket(t *testing.T) {
	// A node that was killed leaves its socket file behind. The next one must
	// not refuse to start over it.
	path := filepath.Join(shortDir(t), "turn-errors.sock")
	stale, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()

	in, err := Listen(path, make(chan []byte, 1))
	if err != nil {
		t.Fatalf("Listen over a stale socket: %v", err)
	}
	in.Close()
}

func TestListenDoesNotStealALiveSocket(t *testing.T) {
	// Two nodes as one user would otherwise silently split the reports.
	out := make(chan []byte, 1)
	_, path := startIntake(t, out)
	if _, err := Listen(path, out); err == nil {
		t.Fatal("second Listen on a live socket succeeded")
	}
}

func TestDefaultSocketPath(t *testing.T) {
	t.Setenv(SocketEnv, "")
	t.Setenv("HOME", "/home/openclaw")
	got, err := DefaultSocketPath()
	if err != nil {
		t.Fatal(err)
	}
	if got != "/home/openclaw/.agentpod/turn-errors.sock" {
		t.Errorf("DefaultSocketPath = %q", got)
	}

	t.Setenv(SocketEnv, "/run/x.sock")
	if got, _ := DefaultSocketPath(); got != "/run/x.sock" {
		t.Errorf("override = %q", got)
	}
}
