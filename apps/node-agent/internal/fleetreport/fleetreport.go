// Package fleetreport is the node's intake for what an agent's own plugin
// reports about its turns, for the hub's fleet Live Activity.
//
// The hub's card hears about a turn from its own ACP → Matrix bridge. A
// harness-mode agent (Hermes with the agentpod-live plugin) runs its own Matrix
// client, so its turns never pass the bridge. Its plugin writes each turn event
// here, as one JSON line on a Unix socket, and the node forwards it to the hub
// as a `fleet.report` frame over the connection it has already authenticated.
//
// Same shape as internal/turnerror, and the same Intake: the node refuses the
// obvious so the plugin hears "no" on its own socket, passes everything else
// through byte for byte, and never blocks — a plugin gets "ok" or an error at
// once, and its harness carries on regardless. The hub validates against the
// contract (packages/contract/src/fleet-report.ts) and decides whose card it
// belongs on; nothing in a report is trusted there either.
package fleetreport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/turnerror"
)

// SocketEnv overrides where the socket lives, for the node and for plugins.
const SocketEnv = "AGENTPOD_FLEET_SOCKET"

// MaxLineBytes caps one report. A report carries at most a 60-character step
// title or a 120-character question, plus ids; 4 KiB is generous.
const MaxLineBytes = 4 << 10

// DefaultSocketPath is where the node listens and where a plugin looks:
// ~/.agentpod/fleet.sock, beside turn-errors.sock and derived the same way.
func DefaultSocketPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv(SocketEnv)); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("fleet socket: no home directory: %w", err)
	}
	return filepath.Join(home, ".agentpod", "fleet.sock"), nil
}

// Frame wraps one plugin line in the frame the hub reads, or says why not.
func Frame(line []byte) ([]byte, error) {
	line = bytes.TrimSpace(line)
	var report map[string]json.RawMessage
	if err := json.Unmarshal(line, &report); err != nil {
		return nil, errors.New("a report is one JSON object")
	}
	for _, key := range []string{"agent", "roomId", "reader"} {
		if !nonEmptyString(report[key]) {
			return nil, fmt.Errorf("a report needs %s, or no station can be matched to it", key)
		}
	}
	var event map[string]json.RawMessage
	if raw, ok := report["event"]; !ok || json.Unmarshal(raw, &event) != nil || !nonEmptyString(event["type"]) {
		return nil, errors.New(`a report needs an "event" object with a "type"`)
	}

	var compact bytes.Buffer
	if err := json.Compact(&compact, line); err != nil {
		return nil, errors.New("a report is one JSON object")
	}
	return json.Marshal(struct {
		Type   string          `json:"type"`
		Report json.RawMessage `json:"report"`
	}{Type: "fleet.report", Report: compact.Bytes()})
}

func nonEmptyString(raw json.RawMessage) bool {
	var s string
	return raw != nil && json.Unmarshal(raw, &s) == nil && strings.TrimSpace(s) != ""
}

// Listen opens the fleet socket at path, readable and writable by this user
// only, and queues each accepted report's frame on out.
func Listen(path string, out chan<- []byte) (*turnerror.Intake, error) {
	return turnerror.ListenWith(path, out, Frame, "fleet", MaxLineBytes)
}

// Forward moves fleet frames from in to the node's outbox until ctx ends,
// but only while the outbox is less than half full. The outbox is shared with
// turn errors, which a room shows; a busy fleet during a hub outage must not
// crowd them out. A frame that finds no room is dropped — the card shows
// now, and the hub drops a stale report anyway.
func Forward(ctx context.Context, in <-chan []byte, out chan<- []byte) {
	dropped := 0
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-in:
			if len(out) >= cap(out)/2 {
				dropped++
				if dropped == 1 || dropped%100 == 0 {
					log.Printf("fleet intake: hub outbox busy, %d report(s) dropped", dropped)
				}
				continue
			}
			select {
			case out <- frame:
				dropped = 0
			default:
				dropped++
			}
		}
	}
}
