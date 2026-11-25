package benchattach

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hermes"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostfs"
)

// record is one station's live attachment: everything detach needs to undo it without asking
// anyone, including after a node restart and after the station itself is gone.
type record struct {
	Version          int                `json:"version"`
	State            string             `json:"state"`
	StationID        string             `json:"station_id"`
	StationKey       string             `json:"station_key"`
	AttemptID        string             `json:"attempt_id"`
	ProfileDir       string             `json:"profile_dir"`
	User             string             `json:"user"`
	Address          string             `json:"address"`
	HostKey          string             `json:"host_key"`
	WorkingDirectory string             `json:"working_directory"`
	ValidBefore      time.Time          `json:"valid_before"`
	KeyPath          string             `json:"key_path"`
	Pinned           string             `json:"pinned"`
	Terminal         hermes.SSHTerminal `json:"terminal"`
	Prior            map[string]any     `json:"prior"`
	AttachedAt       time.Time          `json:"attached_at"`
}

// Journal states. A record from before states existed has none and is attached.
const (
	stateAttaching = "attaching"
	stateAttached  = "attached"
)

// viaJSON is a value as the journal will read it back.
func viaJSON(v map[string]any) map[string]any {
	data, _ := json.Marshal(v)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return out
}

func journalDir(root string) string { return filepath.Join(root, "bench-attachments") }

func journalPath(root, stationID string) string {
	return filepath.Join(journalDir(root), stationID+".json")
}

func readRecord(root, stationID string) (record, bool, error) {
	data, err := os.ReadFile(journalPath(root, stationID))
	if os.IsNotExist(err) {
		return record{}, false, nil
	}
	if err != nil {
		return record{}, false, fmt.Errorf("benchattach: reading journal: %w", err)
	}
	var r record
	if err := json.Unmarshal(data, &r); err != nil || r.StationID != stationID {
		return record{}, false, fmt.Errorf("benchattach: journal for %s is unreadable", stationID)
	}
	return r, true, nil
}

func writeRecord(root string, r record) error {
	if err := os.MkdirAll(journalDir(root), 0o700); err != nil {
		return fmt.Errorf("benchattach: creating journal directory: %w", err)
	}
	r.Version = 1
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := hostfs.AtomicWriteFile(journalPath(root, r.StationID), append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("benchattach: writing journal: %w", err)
	}
	return nil
}

func removeRecord(root, stationID string) error {
	if err := os.Remove(journalPath(root, stationID)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("benchattach: removing journal: %w", err)
	}
	return nil
}

// stations lists every station with a journal, in order.
func stations(root string) []string {
	entries, err := os.ReadDir(journalDir(root))
	if err != nil {
		return nil
	}
	var ids []string
	for _, e := range entries {
		if name := e.Name(); !e.IsDir() && strings.HasSuffix(name, ".json") && !strings.HasPrefix(name, ".") {
			ids = append(ids, strings.TrimSuffix(name, ".json"))
		}
	}
	sort.Strings(ids)
	return ids
}
