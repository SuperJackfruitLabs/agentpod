// Package turnerror is the node's intake for turn errors that a harness will
// not report over ACP itself.
//
// OpenClaw's ACP bridge resolves a failed turn as `end_turn` and drops the
// provider's words; pi-acp does the same with Pi's `errorMessage`. Both
// harnesses expose the failure to their own plugins, so an AgentPod plugin
// inside each one writes it here, as one JSON line on a Unix socket, and the
// node forwards it to the hub as a `turn.error` frame.
//
// The node does not interpret a report. It refuses the obvious (not JSON, no
// words, nothing to match a session by) so the plugin hears "no" on its own
// socket, and passes everything else through byte for byte. The hub validates
// against the contract and decides which turn it belongs to.
//
// Spec: docs/superpowers/specs/2026-09-25-harness-error-standard-design.md §2.
package turnerror

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SocketEnv overrides where the socket lives, for the node and for plugins.
const SocketEnv = "AGENTPOD_TURN_ERROR_SOCKET"

// MaxLineBytes caps one report. The contract caps the message at 8 KiB; the
// rest is room for the fallback chain.
const MaxLineBytes = 16 << 10

// connDeadline bounds one plugin connection. A plugin that connects and never
// writes must not hold a goroutine forever.
const connDeadline = 5 * time.Second

// DefaultSocketPath is where the node listens and where a plugin looks.
//
// Derived from the home directory alone, on purpose. The node and the harness
// run as the same user (on ashram both are `openclaw`), but not necessarily
// from the same kind of service: an XDG_RUNTIME_DIR a systemd user unit gets
// is absent from a plain one. The home directory is the same either way, so
// both sides arrive at the same path without being told.
func DefaultSocketPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv(SocketEnv)); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("turn-error socket: no home directory: %w", err)
	}
	return filepath.Join(home, ".agentpod", "turn-errors.sock"), nil
}

// Frame wraps one plugin line in the frame the hub reads, or says why not.
func Frame(line []byte) ([]byte, error) {
	line = bytes.TrimSpace(line)
	var report map[string]json.RawMessage
	if err := json.Unmarshal(line, &report); err != nil {
		return nil, errors.New("a report is one JSON object")
	}

	var errorObj map[string]json.RawMessage
	if raw, ok := report["error"]; !ok || json.Unmarshal(raw, &errorObj) != nil {
		return nil, errors.New(`a report needs an "error" object`)
	}
	var message string
	if raw, ok := errorObj["message"]; !ok || json.Unmarshal(raw, &message) != nil || strings.TrimSpace(message) == "" {
		return nil, errors.New(`a report needs error.message: the words the harness would not send`)
	}

	if !nonEmptyString(report["acpSessionId"]) && !nonEmptyString(report["harnessSessionKey"]) {
		return nil, errors.New("a report needs acpSessionId or harnessSessionKey, or no turn can be matched to it")
	}

	var compact bytes.Buffer
	if err := json.Compact(&compact, line); err != nil {
		return nil, errors.New("a report is one JSON object")
	}
	return json.Marshal(struct {
		Type   string          `json:"type"`
		Report json.RawMessage `json:"report"`
	}{Type: "turn.error", Report: compact.Bytes()})
}

func nonEmptyString(raw json.RawMessage) bool {
	var s string
	return raw != nil && json.Unmarshal(raw, &s) == nil && strings.TrimSpace(s) != ""
}

// Intake listens for reports and queues their frames on out.
type Intake struct {
	path string
	ln   net.Listener
	out  chan<- []byte
}

// Listen opens the socket at path, readable and writable by this user only —
// anyone who can write here can put words in an agent's room.
//
// A socket file nobody answers on is a crashed node's leftover and is
// replaced. One that answers belongs to a running node, and is not taken:
// two nodes as one user would split the reports between them.
func Listen(path string, out chan<- []byte) (*Intake, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("turn-error socket: %w", err)
	}
	if _, err := os.Lstat(path); err == nil {
		if c, err := net.DialTimeout("unix", path, 200*time.Millisecond); err == nil {
			c.Close()
			return nil, fmt.Errorf("turn-error socket %s is in use by another process", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("turn-error socket: remove stale %s: %w", path, err)
		}
	}

	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("turn-error socket: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("turn-error socket: %w", err)
	}
	return &Intake{path: path, ln: ln, out: out}, nil
}

// Path is where the intake listens.
func (i *Intake) Path() string { return i.path }

// Close stops listening and removes the socket.
func (i *Intake) Close() error { return i.ln.Close() }

// Serve accepts reports until ctx ends or the listener closes.
func (i *Intake) Serve(ctx context.Context) {
	go func() {
		<-ctx.Done()
		i.ln.Close()
	}()
	for {
		conn, err := i.ln.Accept()
		if err != nil {
			if ctx.Err() == nil && !errors.Is(err, net.ErrClosed) {
				log.Printf("turn-error intake: accept: %v", err)
			}
			return
		}
		go i.handle(conn)
	}
}

func (i *Intake) handle(conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(connDeadline))

	reply := func(s string) { conn.Write([]byte(s + "\n")) }

	reader := bufio.NewReaderSize(conn, 4096)
	line, err := readLine(reader, MaxLineBytes)
	if err != nil {
		reply("error: " + err.Error())
		return
	}
	frame, err := Frame(line)
	if err != nil {
		reply("error: " + err.Error())
		return
	}
	select {
	case i.out <- frame:
		reply("ok")
	default:
		// Never block a plugin on a hub connection that may be gone for an
		// hour. It gets told, and its harness carries on regardless.
		log.Printf("turn-error intake: queue full, report dropped")
		reply("error: busy, report dropped")
	}
}

func readLine(r *bufio.Reader, limit int) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		buf = append(buf, chunk...)
		if len(buf) > limit {
			return nil, fmt.Errorf("report larger than %d bytes", limit)
		}
		if err == nil {
			return buf, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		// A plugin that closes its write side without a final newline has
		// still said everything.
		if errors.Is(err, io.EOF) && len(buf) > 0 {
			return buf, nil
		}
		return nil, errors.New("a report is one line, ending in a newline")
	}
}
