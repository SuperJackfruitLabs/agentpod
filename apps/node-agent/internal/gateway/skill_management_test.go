package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

func skillTestHandler(t *testing.T) (Handler, string, string, *int) {
	t.Helper()
	workspace := t.TempDir()
	archive, err := os.ReadFile("../skills/testdata/export-codex.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	pin := fmt.Sprintf("%x", sha256.Sum256(archive))
	calls := new(int)
	h := NewSkillManagementHandler(changesetPassthrough(), SkillManagementDeps{
		NodeID: "fixture-node",
		Resolve: func(ctx context.Context, key string) (string, string, error) {
			if key != "codex:fixture" {
				return "", "", fmt.Errorf("not detected")
			}
			return workspace, "codex", ctx.Err()
		},
		Fetch: func(ctx context.Context, request SkillArtifactRequest) ([]byte, error) {
			*calls++
			if request.StationKey != "codex:fixture" || request.StationID != "station-fixture" || request.ArchiveSHA256 != pin {
				t.Error("download escaped operation binding")
			}
			return archive, nil
		},
	})
	return h, workspace, pin, calls
}

func TestNativeSkillActivationRequiresAnExplicitRuntimeGate(t *testing.T) {
	h, _, pin, _ := skillTestHandler(t)
	base := map[string]string{"key": "codex:fixture", "profile": "fixture"}
	installID := strings.Repeat("a", 32)
	planParams := map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": installID, "stationId": "station-fixture", "archiveSHA256": pin}
	status, err := skillCall(t, h, "skills.plan", planParams)
	if err != nil {
		t.Fatal(err)
	}
	install := status.(skills.InstallPlan)
	if _, err = skillCall(t, h, "skills.apply", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": installID, "stationId": "station-fixture", "expectedPlanDigest": install.PlanDigest}); err != nil {
		t.Fatal(err)
	}
	if _, err = skillCall(t, h, "skills.native.plan", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": strings.Repeat("b", 32), "action": "activate"}); err == nil {
		t.Fatal("native publication ran without an explicit runtime gate")
	}

	archive, err := os.ReadFile("../skills/testdata/export-codex.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	pinned := fmt.Sprintf("%x", sha256.Sum256(archive))
	enabled := NewSkillManagementHandler(changesetPassthrough(), SkillManagementDeps{
		NodeID:          "fixture-node",
		Resolve:         func(context.Context, string) (string, string, error) { return root, "codex", nil },
		Fetch:           func(context.Context, SkillArtifactRequest) ([]byte, error) { return archive, nil },
		Workspaces:      workspacegate.New(),
		AuthorizeNative: func(context.Context, string, string) error { return nil },
		VerifyNative: func(_ context.Context, key, harness string, names []string) (skills.Observation, error) {
			if key != "codex:fixture" || harness != "codex" || strings.Join(names, ",") != "sjl-fixture:sjl-fixture" {
				t.Fatalf("unexpected native loading scope: %q %q %q", key, harness, names)
			}
			yes := true
			now := "2026-09-21T00:00:00Z"
			return skills.Observation{Value: &yes, ObservedAt: &now, Reason: "fresh isolated fixture session advertised every skill"}, nil
		},
	})
	installed, err := skillCall(t, enabled, "skills.plan", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": strings.Repeat("c", 32), "stationId": "station-fixture", "archiveSHA256": pinned})
	if err != nil {
		t.Fatal(err)
	}
	installation := installed.(skills.InstallPlan)
	if _, err = skillCall(t, enabled, "skills.apply", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": strings.Repeat("c", 32), "stationId": "station-fixture", "expectedPlanDigest": installation.PlanDigest}); err != nil {
		t.Fatal(err)
	}
	nativePlan, err := skillCall(t, enabled, "skills.native.plan", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": strings.Repeat("d", 32), "action": "activate"})
	if err != nil {
		t.Fatal(err)
	}
	published := nativePlan.(skills.PlacementPlan)
	if _, err = skillCall(t, enabled, "skills.native.apply", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": strings.Repeat("d", 32), "expectedPlanDigest": published.PlanDigest}); err != nil {
		t.Fatal(err)
	}
	verified, err := skillCall(t, enabled, "skills.native.verify", base)
	if err != nil || verified.(SkillNativeVerifyResult).Verification.Present.Value == nil || !*verified.(SkillNativeVerifyResult).Verification.Present.Value || verified.(SkillNativeVerifyResult).Verification.Loaded.Value == nil || !*verified.(SkillNativeVerifyResult).Verification.Loaded.Value {
		t.Fatalf("native verification: %#v %v", verified, err)
	}
}

func skillCall(t *testing.T, h Handler, verb string, params map[string]string) (any, error) {
	t.Helper()
	raw, _ := json.Marshal(params)
	result, stream, err := h.Handle(t.Context(), verb, raw, nil)
	if stream {
		t.Fatal("management operation streamed")
	}
	return result, err
}

func TestSkillManagementPlansAppliesInspectsAndRollsBack(t *testing.T) {
	h, _, pin, calls := skillTestHandler(t)
	id := strings.Repeat("a", 32)
	base := map[string]string{"key": "codex:fixture", "profile": "fixture"}
	status, err := skillCall(t, h, "skills.verify", base)
	if err != nil {
		t.Fatal(err)
	}
	verified := status.(SkillVerifyResult)
	if verified.Verification.Present.Value == nil || *verified.Verification.Present.Value || verified.Verification.Loaded.Value != nil {
		t.Fatal("missing managed state claimed active")
	}
	base["operationId"] = id
	status, err = skillCall(t, h, "skills.operation", base)
	if err != nil || status.(SkillOperationResult).Receipt != nil {
		t.Fatalf("missing operation: %v", err)
	}
	base["stationId"] = "station-fixture"
	base["archiveSHA256"] = pin
	status, err = skillCall(t, h, "skills.plan", base)
	if err != nil {
		t.Fatal(err)
	}
	plan := status.(skills.InstallPlan)
	if plan.Binding.NodeID != "fixture-node" || plan.Binding.StationKey != "codex:fixture" || plan.Activation != "pending" {
		t.Fatal("unbound plan")
	}
	delete(base, "archiveSHA256")
	base["expectedPlanDigest"] = strings.Repeat("b", 64)
	if _, err := skillCall(t, h, "skills.apply", base); err == nil {
		t.Fatal("unreviewed plan applied")
	}
	if *calls != 1 {
		t.Fatal("rejected review downloaded bytes")
	}
	base["expectedPlanDigest"] = plan.PlanDigest
	status, err = skillCall(t, h, "skills.apply", base)
	if err != nil || status.(skills.InstallReceipt).Phase != "applied" {
		t.Fatalf("apply: %v", err)
	}
	if _, err = skillCall(t, h, "skills.apply", base); err != nil {
		t.Fatal(err)
	}
	if *calls != 2 {
		t.Fatal("completed operation downloaded again")
	}
	delete(base, "stationId")
	delete(base, "expectedPlanDigest")
	base["operationId"] = strings.Repeat("c", 32)
	status, err = skillCall(t, h, "skills.rollback", base)
	if err != nil {
		t.Fatal(err)
	}
	rollback := status.(skills.InstallPlan)
	base["stationId"] = "station-fixture"
	base["expectedPlanDigest"] = rollback.PlanDigest
	if _, err = skillCall(t, h, "skills.apply", base); err != nil {
		t.Fatal(err)
	}
	if *calls != 2 {
		t.Fatal("rollback downloaded bytes")
	}
	status, err = skillCall(t, h, "skills.verify", map[string]string{"key": "codex:fixture", "profile": "fixture"})
	if err != nil || status.(SkillVerifyResult).Verification.Current != nil {
		t.Fatalf("rollback retained head: %v", err)
	}
}

func TestSkillMaintenancePlanIsReadOnlyAndBoundToDetectedProfile(t *testing.T) {
	h, _, pin, _ := skillTestHandler(t)
	id := strings.Repeat("a", 32)
	plan, err := skillCall(t, h, "skills.plan", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": id, "stationId": "station-fixture", "archiveSHA256": pin})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = skillCall(t, h, "skills.apply", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": id, "stationId": "station-fixture", "expectedPlanDigest": plan.(skills.InstallPlan).PlanDigest}); err != nil {
		t.Fatal(err)
	}
	result, err := skillCall(t, h, "skills.maintenance.plan", map[string]string{"key": "codex:fixture", "profile": "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	maintenance := result.(SkillMaintenanceResult)
	if maintenance.NodeID != "fixture-node" || maintenance.Profile != "fixture" || maintenance.Maintenance.PlanDigest == "" || !maintenance.Maintenance.Preview.Empty() {
		t.Fatalf("unexpected maintenance preview: %#v", maintenance)
	}
	if _, err = skillCall(t, h, "skills.maintenance.plan", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": id}); err == nil {
		t.Fatal("maintenance preview accepted caller operation ID")
	}
}

func TestSkillManagementRefusesCallerPathsUnknownFieldsAndUndetectedKeys(t *testing.T) {
	h, workspace, _, calls := skillTestHandler(t)
	for _, raw := range []string{
		`{"key":"codex:fixture","profile":"fixture","workspacePath":"/other"}`,
		`{"key":"codex:fixture","profile":"fixture","url":"https://example.org"}`,
		`{"key":"codex:fixture","profile":"fixture","key":"codex:other"}`,
		`{"Key":"codex:fixture","profile":"fixture"}`,
		`{"key":"codex:fixture","profile":"../other"}`,
		`{"key":"codex:other","profile":"fixture"}`,
		`{"key":"codex:fixture","profile":"fixture"} {}`,
	} {
		if _, _, err := h.Handle(t.Context(), "skills.verify", json.RawMessage(raw), nil); err == nil {
			t.Fatalf("unsafe request accepted: %s", raw)
		}
	}
	if _, err := skillCall(t, h, "skills.verify", map[string]string{"key": "codex:fixture", "profile": "fixture"}); err != nil {
		t.Fatal(err)
	}
	if _, err := skillCall(t, h, "skills.operation", map[string]string{"key": "codex:fixture", "profile": "fixture", "operationId": strings.Repeat("a", 32)}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(workspace)
	if err != nil || len(entries) != 0 || *calls != 0 {
		t.Fatalf("read-only operations wrote or fetched: %v", err)
	}
	result, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil || result != "inner:health" {
		t.Fatal("wrapper swallowed another verb")
	}
}

func TestSkillManagementWrapperPreservesTerminalFrames(t *testing.T) {
	inner := &frameRecorder{}
	h := NewSkillManagementHandler(inner, SkillManagementDeps{})
	if err := h.(FrameHandler).HandleFrame("input", "attach-fixture", json.RawMessage(`{"data":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	if inner.gotType != "input" || inner.gotID != "attach-fixture" {
		t.Fatal("management wrapper dropped terminal input")
	}
}

func TestSkillManagementRejectsWrongProfileBeforeWriting(t *testing.T) {
	h, workspace, pin, _ := skillTestHandler(t)
	_, err := skillCall(t, h, "skills.plan", map[string]string{"key": "codex:fixture", "profile": "other", "operationId": strings.Repeat("a", 32), "stationId": "station-fixture", "archiveSHA256": pin})
	if err == nil {
		t.Fatal("foreign-profile package planned")
	}
	entries, err := os.ReadDir(workspace)
	if err != nil || len(entries) != 0 {
		t.Fatal("rejected package claimed namespace")
	}
}

func TestSkillManagementMissingWorkspaceIsNotVerifiedAbsence(t *testing.T) {
	h, workspace, _, _ := skillTestHandler(t)
	if err := os.Remove(workspace); err != nil {
		t.Fatal(err)
	}
	if _, err := skillCall(t, h, "skills.verify", map[string]string{"key": "codex:fixture", "profile": "fixture"}); err == nil {
		t.Fatal("missing station workspace treated as verified empty profile")
	}
}
