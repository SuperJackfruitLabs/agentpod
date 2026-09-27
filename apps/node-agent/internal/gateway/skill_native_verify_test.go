package gateway

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

// nativeVerifyProbe records the scope every fresh-session probe was asked to
// check, so a test can also assert that no probe ran at all.
type nativeVerifyProbe struct {
	names  [][]string
	result skills.Observation
	err    error
}

func (p *nativeVerifyProbe) verify(_ context.Context, key, harness string, names []string) (skills.Observation, error) {
	p.names = append(p.names, append([]string(nil), names...))
	if key != "codex:fixture" || harness != "codex" {
		return skills.Observation{}, fmt.Errorf("unexpected probe scope %q %q", key, harness)
	}
	return p.result, p.err
}

func nativeVerifyObservation(t *testing.T, value bool, reason string) skills.Observation {
	t.Helper()
	now := "2026-09-22T05:59:13Z"
	return skills.Observation{Value: &value, ObservedAt: &now, Reason: reason}
}

// nativeVerifyFixture installs the managed fixture generation on a
// native-enabled handler. It stops short of native placement so each test can
// choose its own activate/deactivate history.
func nativeVerifyFixture(t *testing.T, probe *nativeVerifyProbe) Handler {
	t.Helper()
	archive, err := os.ReadFile("../skills/testdata/export-codex.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	pin := fmt.Sprintf("%x", sha256.Sum256(archive))
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	h := NewSkillManagementHandler(changesetPassthrough(), SkillManagementDeps{
		NodeID:          "fixture-node",
		Resolve:         func(context.Context, string) (string, string, error) { return root, "codex", nil },
		Fetch:           func(context.Context, SkillArtifactRequest) ([]byte, error) { return archive, nil },
		Workspaces:      workspacegate.New(),
		AuthorizeNative: func(context.Context, string, string) error { return nil },
		VerifyNative:    probe.verify,
	})
	id := strings.Repeat("a", 32)
	plan, err := skillCall(t, h, "skills.plan", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": id, "stationId": "station-fixture", "archiveSHA256": pin})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = skillCall(t, h, "skills.apply", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": id, "stationId": "station-fixture", "expectedPlanDigest": plan.(skills.InstallPlan).PlanDigest}); err != nil {
		t.Fatal(err)
	}
	return h
}

func nativePlacement(t *testing.T, h Handler, id, action string) {
	t.Helper()
	plan, err := skillCall(t, h, "skills.native.plan", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": id, "action": action})
	if err != nil {
		t.Fatalf("native %s plan: %v", action, err)
	}
	if _, err = skillCall(t, h, "skills.native.apply", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": id, "expectedPlanDigest": plan.(skills.PlacementPlan).PlanDigest}); err != nil {
		t.Fatalf("native %s apply: %v", action, err)
	}
}

func nativeVerify(t *testing.T, h Handler) skills.PlacementVerification {
	t.Helper()
	result, err := skillCall(t, h, "skills.native.verify", map[string]string{"key": "codex:fixture", "profile": "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	return result.(SkillNativeVerifyResult).Verification
}

// An absent placement is the case the node could not close before: file
// absence alone is not loading evidence, so the probe must still run, and a
// fresh session that does not advertise the removed names is a real negative.
func TestNativeVerifyAbsentPlacementProvesTheNamesAreNoLongerAdvertised(t *testing.T) {
	probe := &nativeVerifyProbe{result: nativeVerifyObservation(t, false, "A fresh isolated ACP session did not advertise sjl-fixture")}
	h := nativeVerifyFixture(t, probe)
	nativePlacement(t, h, strings.Repeat("b", 32), "activate")
	nativePlacement(t, h, strings.Repeat("c", 32), "deactivate")
	verification := nativeVerify(t, h)
	if verification.Present.Value == nil || *verification.Present.Value || len(verification.DiscoveryNames) != 0 {
		t.Fatalf("absent placement evidence: %+v", verification)
	}
	if len(probe.names) != 1 || strings.Join(probe.names[0], ",") != "sjl-fixture" {
		t.Fatalf("probe scope came from somewhere other than the last verified generation: %q", probe.names)
	}
	loaded := verification.Loaded
	if loaded.Value == nil || *loaded.Value || loaded.ObservedAt == nil {
		t.Fatalf("absent placement did not produce a negative loading observation: %+v", loaded)
	}
	if !strings.Contains(loaded.Reason, "did not advertise") || !strings.Contains(loaded.Reason, "last verified generation") {
		t.Fatalf("negative loading reason omits its evidence or its name source: %q", loaded.Reason)
	}
}

// The single most important requirement: a probe that could not answer is
// never a negative. It stays unknown, and the reason names the condition.
func TestNativeVerifyAbsentPlacementProbeFailureStaysUnknown(t *testing.T) {
	probe := &nativeVerifyProbe{err: fmt.Errorf("fresh isolated Codex session could not establish discovery: ACP discovery deadline exceeded")}
	h := nativeVerifyFixture(t, probe)
	nativePlacement(t, h, strings.Repeat("b", 32), "activate")
	nativePlacement(t, h, strings.Repeat("c", 32), "deactivate")
	loaded := nativeVerify(t, h).Loaded
	if loaded.Value != nil || loaded.ObservedAt != nil {
		t.Fatalf("a failed probe became a loading verdict: %+v", loaded)
	}
	if !strings.Contains(loaded.Reason, "deadline exceeded") {
		t.Fatalf("unknown loading reason does not name the condition: %q", loaded.Reason)
	}
	if len(probe.names) != 1 {
		t.Fatalf("probe ran %d times", len(probe.names))
	}
}

// A provider that answers "I could not look" (runtime not ready, no Node
// runtime, no names selected) returns an observation with no value. That must
// survive unchanged.
func TestNativeVerifyAbsentPlacementUnreadyRuntimeStaysUnknown(t *testing.T) {
	probe := &nativeVerifyProbe{result: skills.Observation{Reason: "Adapter and bundled engine pair has no recorded native discovery evidence"}}
	h := nativeVerifyFixture(t, probe)
	nativePlacement(t, h, strings.Repeat("b", 32), "activate")
	nativePlacement(t, h, strings.Repeat("c", 32), "deactivate")
	loaded := nativeVerify(t, h).Loaded
	if loaded.Value != nil || loaded.ObservedAt != nil {
		t.Fatalf("an unready runtime became a loading verdict: %+v", loaded)
	}
	if !strings.Contains(loaded.Reason, "no recorded native discovery evidence") {
		t.Fatalf("unknown loading reason lost the provider's condition: %q", loaded.Reason)
	}
}

// Names are never invented. With no native placement history there is nothing
// to check, so the answer is unknown and no probe runs.
func TestNativeVerifyAbsentPlacementWithoutHistoryStaysUnknownAndDoesNotProbe(t *testing.T) {
	probe := &nativeVerifyProbe{result: nativeVerifyObservation(t, false, "unused")}
	h := nativeVerifyFixture(t, probe)
	verification := nativeVerify(t, h)
	if verification.Present.Value == nil || *verification.Present.Value {
		t.Fatalf("unplaced station reported present: %+v", verification.Present)
	}
	if len(probe.names) != 0 {
		t.Fatalf("probe ran without names from a verified generation: %q", probe.names)
	}
	loaded := verification.Loaded
	if loaded.Value != nil || loaded.ObservedAt != nil {
		t.Fatalf("indeterminable names became a loading verdict: %+v", loaded)
	}
	if !strings.Contains(loaded.Reason, "no previous verified native generation") {
		t.Fatalf("unknown loading reason does not name the condition: %q", loaded.Reason)
	}
}

// The other direction of the same probe: the files are gone but a fresh
// session still advertises the command. That is a true, and it is evidence
// that a removal has not taken effect for new sessions.
func TestNativeVerifyAbsentPlacementStillAdvertisedIsLoadedTrue(t *testing.T) {
	probe := &nativeVerifyProbe{result: nativeVerifyObservation(t, true, "A fresh isolated ACP session advertised every expected native skill name")}
	h := nativeVerifyFixture(t, probe)
	nativePlacement(t, h, strings.Repeat("b", 32), "activate")
	nativePlacement(t, h, strings.Repeat("c", 32), "deactivate")
	loaded := nativeVerify(t, h).Loaded
	if loaded.Value == nil || !*loaded.Value || loaded.ObservedAt == nil {
		t.Fatalf("a still-advertised removed skill was not reported loaded: %+v", loaded)
	}
}

// A present placement keeps checking its own discovery names, unchanged.
func TestNativeVerifyPresentPlacementStillChecksItsOwnNames(t *testing.T) {
	probe := &nativeVerifyProbe{result: nativeVerifyObservation(t, true, "A fresh isolated ACP session advertised every expected native skill name")}
	h := nativeVerifyFixture(t, probe)
	nativePlacement(t, h, strings.Repeat("b", 32), "activate")
	verification := nativeVerify(t, h)
	if verification.Present.Value == nil || !*verification.Present.Value || strings.Join(verification.DiscoveryNames, ",") != "sjl-fixture" {
		t.Fatalf("present placement evidence: %+v", verification)
	}
	if len(probe.names) != 1 || strings.Join(probe.names[0], ",") != "sjl-fixture" {
		t.Fatalf("present probe scope: %q", probe.names)
	}
	loaded := verification.Loaded
	if loaded.Value == nil || !*loaded.Value || strings.Contains(loaded.Reason, "last verified generation") {
		t.Fatalf("present placement loading evidence changed: %+v", loaded)
	}
}
