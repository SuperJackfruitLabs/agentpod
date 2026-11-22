package benchbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func change(r Registry, board string) ProfileChange {
	p := r.Profiles[0]
	return ProfileChange{ID: p.ID, TenantID: p.TenantID, BoardID: board, AgentID: p.AgentID, StationID: p.StationID}
}

func refusalCode(t *testing.T, err error) string {
	t.Helper()
	var refusal *Refusal
	if !errors.As(err, &refusal) {
		t.Fatalf("not a registry refusal: %v", err)
	}
	return refusal.Code
}

// The node, not an operator, computes registry_sha256: the reply's digest is the sha256 of the
// exact bytes now installed, and every target it serves carries it.
func TestRegistrySetReportsTheDigestOfTheInstalledBytesAndReloads(t *testing.T) {
	path, r := registryFixture(t)
	reloads := 0
	m := &RegistryManager{Path: path, NodeID: r.NodeID, Reload: func() { reloads++ }}
	before := m.Status(context.Background())
	if !before.Valid || len(before.Profiles) != 1 {
		t.Fatalf("fixture registry not served: %+v", before)
	}
	// Changing the stage's board is one change naming the selector; repositories, arguments and
	// environment stay as installed.
	got, err := m.Set(context.Background(), SetRequest{Profile: ptr(change(r, "brd_moved0001"))})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if got.RegistrySHA256 != rawSHA(raw) || got.RegistrySHA256 == before.RegistrySHA256 || reloads != 1 {
		t.Fatalf("digest %s, file %s, before %s, reloads %d", got.RegistrySHA256, rawSHA(raw), before.RegistrySHA256, reloads)
	}
	if len(got.Profiles) != 1 || got.Profiles[0].Target.BoardID != "brd_moved0001" || got.Profiles[0].Target.RegistrySHA256 != got.RegistrySHA256 {
		t.Fatalf("served target: %+v", got.Profiles)
	}
	installed, _, err := readRegistry(path, r.NodeID)
	if err != nil || installed.Profiles[0].Repositories[0].Repository != "/fixture/repo" || installed.Profiles[0].Arguments[0] != "/bin/sh" {
		t.Fatalf("unchanged fields not kept: %+v %v", installed.Profiles, err)
	}
	if got.Profiles[0].Repositories[0].RepositorySHA256 != rawSHA([]byte("/fixture/repo")) {
		t.Fatal("repository digest is not the clone identity's")
	}
	// The reply never carries a clone identity or an argument.
	encoded, _ := json.Marshal(got)
	if bytes.Contains(encoded, []byte("/fixture/repo")) || bytes.Contains(encoded, []byte("/bin/sh")) {
		t.Fatalf("status leaks private registry data: %s", encoded)
	}
}

func TestRegistryRefusedChangeWritesNothing(t *testing.T) {
	path, r := registryFixture(t)
	reloads := 0
	m := &RegistryManager{Path: path, NodeID: r.NodeID, Reload: func() { reloads++ }}
	original, _ := os.ReadFile(path)
	bad := change(r, r.Profiles[0].BoardID)
	bad.Arguments = []string{"relative-worker"}
	if _, err := m.Set(context.Background(), SetRequest{Profile: &bad}); refusalCode(t, err) != ProblemInvalid {
		t.Fatalf("relative worker accepted: %v", err)
	}
	other := change(r, r.Profiles[0].BoardID)
	other.ID = "another"
	other.CheckpointRepository, other.Repositories, other.Arguments = "api", r.Profiles[0].Repositories, []string{"/bin/sh"}
	if _, err := m.Set(context.Background(), SetRequest{Profile: &other}); refusalCode(t, err) != "selector_taken" {
		t.Fatalf("second profile for one selector accepted: %v", err)
	}
	fresh := ProfileChange{ID: "fresh", TenantID: "fleet_fixture", BoardID: "brd_fixture002", AgentID: "agt_fixture", StationID: "station_two"}
	if _, err := m.Set(context.Background(), SetRequest{Profile: &fresh}); refusalCode(t, err) != "invalid_request" {
		t.Fatalf("new profile with no repositories accepted: %v", err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(after, original) || reloads != 0 {
		t.Fatal("a refused change touched the installed registry")
	}
}

func TestRegistryStartsEmptyAndTheLastStageCanBeRemoved(t *testing.T) {
	path, r := registryFixture(t)
	first := r.Profiles[0]
	r.Profiles = []LocalProfile{}
	writeRegistry(t, path, r)
	m := &RegistryManager{Path: path, NodeID: r.NodeID}
	if s := m.Status(context.Background()); !s.Valid || len(s.Profiles) != 0 {
		t.Fatalf("an installed registry with no stage is refused: %+v", s)
	}
	add := ProfileChange{ID: first.ID, TenantID: first.TenantID, BoardID: first.BoardID, AgentID: first.AgentID, StationID: first.StationID,
		CheckpointRepository: "api", Repositories: first.Repositories, Arguments: first.Arguments}
	launch := "registered-v1"
	add.Launch = &launch
	got, err := m.Set(context.Background(), SetRequest{Profile: &add})
	if err != nil || len(got.Profiles) != 1 || got.Profiles[0].Launch != "registered-v1" {
		t.Fatalf("first stage not added: %+v %v", got, err)
	}
	if _, err = m.Remove(context.Background(), RemoveRequest{ID: "missing"}); refusalCode(t, err) != "not_found" {
		t.Fatal("removing an unknown profile succeeded")
	}
	got, err = m.Remove(context.Background(), RemoveRequest{ID: first.ID})
	if err != nil || !got.Valid || len(got.Profiles) != 0 {
		t.Fatalf("last stage not removed: %+v %v", got, err)
	}
}

// After a worker update the pin is stale: status names it, a plain change is refused, and a
// repin re-pins both installed-byte digests without touching anything else.
func TestRegistryRepinAfterAWorkerUpdate(t *testing.T) {
	path, r := registryFixture(t)
	m := &RegistryManager{Path: path, NodeID: r.NodeID}
	if os.WriteFile(r.WorkerPath, []byte("#!/bin/sh\necho updated\n"), 0700) != nil {
		t.Fatal("update worker")
	}
	s := m.Status(context.Background())
	if s.Valid || s.Problem != ProblemWorkerPin || s.WorkerInstalledSHA256 == s.WorkerSHA256 || s.WorkerInstalledSHA256 == "" {
		t.Fatalf("stale worker pin not reported: %+v", s)
	}
	if _, err := m.Set(context.Background(), SetRequest{Profile: ptr(change(r, "brd_moved0002"))}); refusalCode(t, err) != ProblemWorkerPin {
		t.Fatalf("a change over a stale pin was written: %v", err)
	}
	got, err := m.Set(context.Background(), SetRequest{Repin: true})
	if err != nil || !got.Valid || got.WorkerSHA256 != got.WorkerInstalledSHA256 || got.Profiles[0].Target.WorkerSHA256 != got.WorkerSHA256 {
		t.Fatalf("repin failed: %+v %v", got, err)
	}
}

func TestRegistryUnconfiguredAndUnreadableAreNamed(t *testing.T) {
	if s := (&RegistryManager{NodeID: "node_x"}).Status(context.Background()); s.Configured || s.Problem != ProblemUnconfigured {
		t.Fatalf("unconfigured: %+v", s)
	}
	path, r := registryFixture(t)
	if os.Chmod(path, 0644) != nil {
		t.Fatal("chmod")
	}
	m := &RegistryManager{Path: path, NodeID: r.NodeID}
	if s := m.Status(context.Background()); s.Problem != ProblemUnreadable {
		t.Fatalf("public registry: %+v", s)
	}
	if _, err := m.Set(context.Background(), SetRequest{Repin: true}); err == nil || !strings.Contains(err.Error(), ProblemUnreadable) {
		t.Fatalf("a public registry was edited: %v", err)
	}
}

func ptr[T any](v T) *T { return &v }
