package benchbridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
)

func registryFixture(t *testing.T) (string, Registry) {
	t.Helper()
	root := intentStore(t).Root
	dirs := make([]string, 4)
	for i, name := range []string{"state", "intents", "contexts", "data"} {
		dirs[i] = filepath.Join(root, name)
		if os.Mkdir(dirs[i], 0700) != nil {
			t.Fatal("private directory")
		}
	}
	worker := filepath.Join(root, "worker")
	if os.WriteFile(worker, []byte("#!/bin/sh\nexit 0\n"), 0700) != nil {
		t.Fatal("fixture worker")
	}
	workerSHA, err := executableHash(worker)
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		t.Fatal(err)
	}
	selfSHA, err := executableHash(self)
	if err != nil {
		t.Fatal(err)
	}
	_, request := prepareFixture(t)
	r := Registry{Version: "agentpod.private-coordinator-registry.v1", NodeID: request.Target.NodeID, HostID: request.Target.HostID,
		Socket: filepath.Join(root, "source.sock"), StateRoot: dirs[0], IntentRoot: dirs[1], ContextParent: dirs[2], DataRoot: dirs[3],
		WorkerPath: worker, WorkerSHA256: workerSHA, CoordinatorSHA256: selfSHA, Profiles: []LocalProfile{{ID: "fixture", TenantID: request.Target.TenantID,
			BoardID: request.Target.BoardID, AgentID: request.Target.AgentID, StationID: request.Target.StationID, CheckpointRepository: "api",
			Repositories: []LocalRepository{{Name: "api", Repository: "/fixture/repo", Base: "main", ObjectFormat: "sha1"}}, Arguments: []string{"/bin/sh"}, Environment: map[string]string{"PATH": "/usr/bin:/bin"}}}}
	path := filepath.Join(root, "registry.json")
	writeRegistry(t, path, r)
	return path, r
}
func writeRegistry(t *testing.T, path string, r Registry) {
	t.Helper()
	raw, err := json.Marshal(r)
	if err != nil || os.WriteFile(path, raw, 0600) != nil {
		t.Fatal("write registry")
	}
}
func TestRegistryPinsActualInstalledBytesAndRefusesCredentialEnvironment(t *testing.T) {
	path, r := registryFixture(t)
	got, digest, err := readRegistry(path, r.NodeID)
	raw, _ := os.ReadFile(path)
	if err != nil || digest != rawSHA(raw) || got.WorkerSHA256 != r.WorkerSHA256 {
		t.Fatalf("valid registry refused: %v", err)
	}
	r.Profiles[0].Environment["SERVICE_TOKEN"] = "fixture-must-not-enter-worker"
	writeRegistry(t, path, r)
	if _, _, err = readRegistry(path, r.NodeID); err == nil {
		t.Fatal("credential environment accepted")
	}
	delete(r.Profiles[0].Environment, "SERVICE_TOKEN")
	writeRegistry(t, path, r)
	if os.WriteFile(r.WorkerPath, []byte("changed trusted worker"), 0700) != nil {
		t.Fatal("change worker")
	}
	if _, _, err = readRegistry(path, r.NodeID); err == nil {
		t.Fatal("changed installed worker accepted")
	}
}
func TestRegistryRefusesWrongNodePublicConfigAndSymlink(t *testing.T) {
	path, r := registryFixture(t)
	if _, _, err := readRegistry(path, "foreign-node"); err == nil {
		t.Fatal("foreign node accepted")
	}
	if os.Chmod(path, 0644) != nil {
		t.Fatal("chmod")
	}
	if _, _, err := readRegistry(path, r.NodeID); err == nil {
		t.Fatal("public config accepted")
	}
	if os.Chmod(path, 0600) != nil {
		t.Fatal("chmod")
	}
	alias := filepath.Join(filepath.Dir(path), "alias.json")
	if os.Symlink(path, alias) != nil {
		t.Fatal("symlink")
	}
	if _, _, err := readRegistry(alias, r.NodeID); err == nil {
		t.Fatal("symlink accepted")
	}
}

func TestRegistryRefusesAmbiguousSelectorsAndInvalidWorkerInputsBeforeReadiness(t *testing.T) {
	path, r := registryFixture(t)
	duplicate := r.Profiles[0]
	duplicate.ID = "another-profile"
	r.Profiles = append(r.Profiles, duplicate)
	writeRegistry(t, path, r)
	if _, _, err := readRegistry(path, r.NodeID); err == nil {
		t.Fatal("ambiguous registry selector accepted")
	}
	r.Profiles = r.Profiles[:1]
	r.Profiles[0].Arguments = []string{"relative-command"}
	writeRegistry(t, path, r)
	if _, _, err := readRegistry(path, r.NodeID); err == nil {
		t.Fatal("relative worker command advertised")
	}
	r.Profiles[0].Arguments = []string{"/bin/sh"}
	r.Profiles[0].Environment["LANG"] = "en_US\ninjected"
	writeRegistry(t, path, r)
	if _, _, err := readRegistry(path, r.NodeID); err == nil {
		t.Fatal("invalid worker environment advertised")
	}
}

func TestRegistryLaunchIsOptInAndClosed(t *testing.T) {
	path, r := registryFixture(t)
	raw, _ := os.ReadFile(path)
	if string(raw) == "" || json.Valid(raw) && strings.Contains(string(raw), `"launch"`) {
		t.Fatal("default registry names a launch")
	}
	r.Profiles[0].Launch = "registered-v1"
	writeRegistry(t, path, r)
	got, _, err := readRegistry(path, r.NodeID)
	if err != nil || got.Profiles[0].Launch != "registered-v1" {
		t.Fatal("registered launch opt-in refused", err)
	}
	r.Profiles[0].Launch = "registered-v2"
	writeRegistry(t, path, r)
	if _, _, err = readRegistry(path, r.NodeID); err == nil {
		t.Fatal("unknown launch accepted")
	}
}

func TestOnlyTheRegisteredProfileSelectsTheRegisteredLaunch(t *testing.T) {
	path, r := registryFixture(t)
	h := &Handler{registry: r}
	_, request := prepareFixture(t)
	if _, ok := h.manager(request, r.Profiles[0], Intent{}, "prepare").(groupedCoordinator); !ok {
		t.Fatal("default profile left the grouped launch")
	}
	r.Profiles[0].Launch = "registered-v1"
	writeRegistry(t, path, r)
	m := h.manager(request, r.Profiles[0], Intent{}, "prepare")
	launch, ok := m.(benchlaunch.Coordinator)
	if !ok || launch.Journal.Root != filepath.Join(r.StateRoot, "registered") {
		t.Fatal("registered profile not selected")
	}
	if st, err := os.Stat(launch.Journal.Root); err != nil || st.Mode().Perm() != 0700 {
		t.Fatal("registered journal is not private", err)
	}
}

func TestRegisteredRefusalKeepsItsCode(t *testing.T) {
	_, request := prepareFixture(t)
	response, err := failed(request, &benchlaunch.Refusal{Code: "capacity_exhausted"})
	if err != nil || response.State != "refused" || response.Code != "capacity_exhausted" {
		t.Fatal("capacity refusal lost", response, err)
	}
	if response, err = failed(request, ErrIntent); err == nil || response.State != "pending" {
		t.Fatal("unknown failure was not parked")
	}
	raw, _ := json.Marshal(transportOutcome(request, response, err))
	if !strings.Contains(string(raw), `"pending"`) {
		t.Fatal("parked outcome not pending on the wire")
	}
}
