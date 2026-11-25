package benchbridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchremote"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// A remote-v1 profile runs no worker on the bench host: it has no worker
// arguments, and one that names some is refused. It selects the remote
// launch, with its own private journal.
func TestRegistryRemoteLaunchHasNoWorker(t *testing.T) {
	path, r := registryFixture(t)
	r.Profiles[0].Launch = benchremote.Mode
	writeRegistry(t, path, r)
	if _, _, err := readRegistry(path, r.NodeID); err == nil {
		t.Fatal("remote profile with worker arguments accepted")
	}
	r.Profiles[0].Arguments = []string{}
	writeRegistry(t, path, r)
	got, _, err := readRegistry(path, r.NodeID)
	if err != nil || got.Profiles[0].Launch != benchremote.Mode {
		t.Fatal("remote profile refused", err)
	}
	r.Profiles[0].Launch = ""
	writeRegistry(t, path, r)
	if _, _, err := readRegistry(path, r.NodeID); err == nil {
		t.Fatal("grouped profile without worker arguments accepted")
	}
	_, request := prepareFixture(t)
	m, ok := (&Handler{registry: got}).manager(request, got.Profiles[0], Intent{}, "prepare").(benchremote.Coordinator)
	if !ok || m.Journal.Root != filepath.Join(got.StateRoot, "remote") {
		t.Fatal("remote profile did not select the remote launch")
	}
	if st, err := os.Stat(m.Journal.Root); err != nil || st.Mode().Perm() != 0700 {
		t.Fatal("remote journal is not private", err)
	}
}

// A stage switched from one-shot to remote on the same node keeps none of
// its old worker: the hub sends only the new launch value.
func TestRegistrySwitchToRemoteClearsTheOldWorker(t *testing.T) {
	path, r := registryFixture(t)
	m := &RegistryManager{Path: path, NodeID: r.NodeID}
	switched := change(r, r.Profiles[0].BoardID)
	switched.Launch = ptr(benchremote.Mode)
	got, err := m.Set(context.Background(), SetRequest{Profile: &switched})
	if err != nil || len(got.Profiles) != 1 || got.Profiles[0].Launch != benchremote.Mode {
		t.Fatal("switch to remote refused", err)
	}
	installed, _, err := readRegistry(path, r.NodeID)
	if err != nil || len(installed.Profiles[0].Arguments) != 0 || len(installed.Profiles[0].Environment) != 0 {
		t.Fatalf("old worker kept: %+v %v", installed.Profiles, err)
	}
	// A new remote stage needs no worker arguments either.
	fresh := ProfileChange{ID: "fresh", TenantID: r.Profiles[0].TenantID, BoardID: "brd_fixture002", AgentID: r.Profiles[0].AgentID, StationID: "station_two",
		CheckpointRepository: "api", Repositories: r.Profiles[0].Repositories, Launch: ptr(benchremote.Mode)}
	if _, err := m.Set(context.Background(), SetRequest{Profile: &fresh}); err != nil {
		t.Fatal("new remote profile refused", err)
	}
	// Back to one-shot gives the worker again.
	back := change(r, r.Profiles[0].BoardID)
	back.Launch, back.Arguments, back.Environment = ptr("registered-v1"), []string{"/bin/sh"}, map[string]string{"PATH": "/usr/bin:/bin"}
	if _, err := m.Set(context.Background(), SetRequest{Profile: &back}); err != nil {
		t.Fatal("switch back to one-shot refused", err)
	}
}

func remoteRequest(t *testing.T, name string) ([]byte, benchcoordinatorwire.Request) {
	t.Helper()
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Requests []struct {
			Name  string
			Value json.RawMessage
		}
	}
	if json.Unmarshal(raw, &fixture) != nil {
		t.Fatal("fixture invalid")
	}
	for _, c := range fixture.Requests {
		if c.Name == name {
			r, err := benchcoordinatorwire.ParseRequest(c.Value)
			if err != nil {
				t.Fatal(err)
			}
			return c.Value, r
		}
	}
	t.Fatal("no fixture", name)
	return nil, benchcoordinatorwire.Request{}
}

// attach and finish are the remote launch's alone; any other launch refuses
// them as unsupported before it asks anyone anything.
func TestAttachAndFinishUnsupportedForOtherLaunches(t *testing.T) {
	for _, name := range []string{"attach", "finish"} {
		raw, request := remoteRequest(t, name)
		for _, launch := range []string{"", "registered-v1"} {
			// A nil client and current make any call past the launch check panic.
			response, err := (&Handler{}).remote(context.Background(), request, raw, LocalProfile{Launch: launch}, Intent{})
			if err != nil || response.State != "refused" || response.Code != "unsupported" {
				t.Fatalf("%s on launch %q: %+v %v", name, launch, response, err)
			}
		}
	}
}

func TestAttachedResponseCarriesTheCredentialOnly(t *testing.T) {
	_, request := remoteRequest(t, "attach")
	raw, _ := os.ReadFile("../benchworkspace/testdata/remote-credentials.json")
	var corpus struct {
		Response struct{ Valid map[string]json.RawMessage }
	}
	if json.Unmarshal(raw, &corpus) != nil {
		t.Fatal("remote corpus")
	}
	credential, err := benchworkspace.ParseRemoteCredentialResponse(corpus.Response.Valid["issued"], 200)
	if err != nil {
		t.Fatal(err)
	}
	response, err := attachedResponse(request, credential)
	if err != nil || response.State != "attached" || response.Credential == nil || response.Credential.ValidBefore != "2026-11-25T12:30:00.123456789Z" ||
		response.Credential.WorkingDirectory != "/bounded/benches/card-1" {
		t.Fatalf("attached reply wrong: %+v %v", response.Credential, err)
	}
}
