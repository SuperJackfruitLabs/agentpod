package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchbridge"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

func fileSHA(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// installedRegistry writes a private registry with no stage, as a bench host installs it.
func installedRegistry(t *testing.T, workerSHA string) (string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil || os.Chmod(root, 0700) != nil {
		t.Fatal("private root")
	}
	dirs := map[string]string{}
	for _, name := range []string{"state", "intents", "contexts", "data"} {
		dirs[name] = filepath.Join(root, name)
		if os.Mkdir(dirs[name], 0700) != nil {
			t.Fatal("private directory")
		}
	}
	worker := filepath.Join(root, "worker")
	if os.WriteFile(worker, []byte("#!/bin/sh\nexit 0\n"), 0700) != nil {
		t.Fatal("worker")
	}
	if workerSHA == "" {
		workerSHA = fileSHA(t, worker)
	}
	self, _ := os.Executable()
	self, _ = filepath.EvalSymlinks(self)
	registry := map[string]any{"version": benchbridge.RegistryVersion, "node_id": "node_reload", "host_id": "host_reload",
		"socket": filepath.Join(root, "bench.sock"), "state_root": dirs["state"], "intent_root": dirs["intents"],
		"data_root": dirs["data"], "context_parent": dirs["contexts"], "worker_path": worker, "worker_sha256": workerSHA,
		"coordinator_implementation_sha256": fileSHA(t, self), "profiles": []any{}}
	raw, _ := json.Marshal(registry)
	path := filepath.Join(root, "registry.json")
	if os.WriteFile(path, raw, 0600) != nil {
		t.Fatal("registry")
	}
	return path, worker
}

func call(t *testing.T, h gateway.Handler, verb string, params any) (benchbridge.RegistryStatus, error) {
	t.Helper()
	raw, _ := json.Marshal(params)
	value, _, err := h.Handle(context.Background(), verb, raw, nil)
	if err != nil {
		return benchbridge.RegistryStatus{}, err
	}
	status, ok := value.(benchbridge.RegistryStatus)
	if !ok {
		t.Fatalf("%s answered %T", verb, value)
	}
	return status, nil
}

var stage = map[string]any{"profile": map[string]any{"id": "bench-stage", "tenant_id": "fleet_reload", "board_id": "brd_reload0001",
	"agent_id": "agt_reload01", "station_id": "station_reload", "checkpoint_repository": "app",
	"repositories": []any{map[string]any{"name": "app", "repository": "/srv/repos/app.git", "base": "main", "object_format": "sha1"}},
	"arguments":    []any{"/bin/sh"}, "launch": "registered-v1"}}

// A stage written from the hub is served at once: the coordinator the node dispatches to is
// rebuilt from the new file, with no restart, and serves the digest the reply named.
func TestRegistrySetHotReloadsTheCoordinator(t *testing.T) {
	path, _ := installedRegistry(t, "")
	cfg := config.Config{Hub: "https://hub.test", NodeID: "node_reload", NodeSecret: "secret", ProposedCheckpointRegistry: path}
	slot := newCoordinatorSlot(cfg)
	defer slot.close()
	before, err := slot.current()
	if err != nil || before == nil {
		t.Fatalf("empty registry not served: %v", err)
	}
	m := &benchbridge.RegistryManager{Path: path, NodeID: cfg.NodeID, Reload: slot.reload}
	h := gateway.HandlerFunc(func(ctx context.Context, verb string, params json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		v, err := registryVerb(ctx, m, verb, params)
		return v, false, err
	})
	got, err := call(t, h, benchbridge.VerbRegistrySet, stage)
	if err != nil {
		t.Fatal(err)
	}
	after, err := slot.current()
	if err != nil || after == before || after.RegistrySHA256() != got.RegistrySHA256 || got.RegistrySHA256 != fileSHA(t, path) {
		t.Fatalf("coordinator not reloaded: err %v, served %s, reply %s", err, after.RegistrySHA256(), got.RegistrySHA256)
	}
	if _, err = call(t, h, benchbridge.VerbRegistrySet, map[string]any{"profile": map[string]any{"id": "x"}, "token": "no"}); err == nil {
		t.Fatal("an unknown field was accepted")
	}
}

// A registry broken at start (a stale worker pin after an update) starts serving after a
// repin, without a restart.
func TestARegistryBrokenAtStartServesAfterARepin(t *testing.T) {
	path, _ := installedRegistry(t, "0000000000000000000000000000000000000000000000000000000000000000")
	cfg := config.Config{Hub: "https://hub.test", NodeID: "node_reload", NodeSecret: "secret", ProposedCheckpointRegistry: path}
	h, closeAll := checkpointCoordinatorHandler(gateway.HandlerFunc(func(context.Context, string, json.RawMessage, func(int, string, bool, string) error) (any, bool, error) {
		return "ordinary", false, nil
	}), cfg)
	defer closeAll()
	status, err := call(t, h, benchbridge.VerbRegistryStatus, map[string]any{})
	if err != nil || status.Valid || status.Problem != benchbridge.ProblemWorkerPin {
		t.Fatalf("stale pin not reported: %+v %v", status, err)
	}
	status, err = call(t, h, benchbridge.VerbRegistrySet, map[string]any{"repin": true})
	if err != nil || !status.Valid {
		t.Fatalf("repin refused: %+v %v", status, err)
	}
	status, err = call(t, h, benchbridge.VerbRegistrySet, stage)
	if err != nil || len(status.Profiles) != 1 || status.Profiles[0].Target.RegistrySHA256 != status.RegistrySHA256 {
		t.Fatalf("stage not served after repin: %+v %v", status, err)
	}
}

func TestRegistryVerbsAnswerWithNoRegistryPinned(t *testing.T) {
	h, closeAll := checkpointCoordinatorHandler(gateway.HandlerFunc(func(context.Context, string, json.RawMessage, func(int, string, bool, string) error) (any, bool, error) {
		return "ordinary", false, nil
	}), config.Config{NodeID: "node_reload"})
	defer closeAll()
	status, err := call(t, h, benchbridge.VerbRegistryStatus, map[string]any{})
	if err != nil || status.Configured || status.Problem != benchbridge.ProblemUnconfigured {
		t.Fatalf("unconfigured node: %+v %v", status, err)
	}
	if _, err = call(t, h, benchbridge.VerbRegistrySet, stage); err == nil {
		t.Fatal("a node with no registry accepted a stage")
	}
}
