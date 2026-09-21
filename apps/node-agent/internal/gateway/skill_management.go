package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

// Resolve must require the complete, currently detected station key and return
// its workspace and harness. No caller-supplied path reaches the install store.
type SkillManagementDeps struct {
	NodeID          string
	Resolve         func(context.Context, string) (workspace, harness string, err error)
	Fetch           SkillArtifactFetcher
	Workspaces      *workspacegate.Coordinator
	AuthorizeNative func(context.Context, string, string) error
	VerifyNative    func(context.Context, string, string, []string) (skills.Observation, error)
}
type SkillOperationResult struct {
	Receipt *skills.InstallReceipt `json:"receipt"`
}
type SkillVerifyResult struct {
	NodeID       string                     `json:"nodeId"`
	StationKey   string                     `json:"stationKey"`
	Harness      string                     `json:"harness"`
	Profile      string                     `json:"profile"`
	Verification skills.InstallVerification `json:"verification"`
}
type SkillRetentionResult struct {
	NodeID     string                     `json:"nodeId"`
	StationKey string                     `json:"stationKey"`
	Harness    string                     `json:"harness"`
	Profile    string                     `json:"profile"`
	Retention  skills.RetentionInspection `json:"retention"`
}
type SkillMaintenanceResult struct {
	NodeID      string                 `json:"nodeId"`
	StationKey  string                 `json:"stationKey"`
	Harness     string                 `json:"harness"`
	Profile     string                 `json:"profile"`
	Maintenance skills.MaintenancePlan `json:"maintenance"`
}
type SkillNativeOperationResult struct {
	Receipt *skills.PlacementReceipt `json:"receipt"`
}
type SkillNativeVerifyResult struct {
	NodeID       string                       `json:"nodeId"`
	StationKey   string                       `json:"stationKey"`
	Harness      string                       `json:"harness"`
	Profile      string                       `json:"profile"`
	Verification skills.PlacementVerification `json:"verification"`
}
type skillManagementHandler struct {
	inner Handler
	deps  SkillManagementDeps
}

func NewSkillManagementHandler(inner Handler, deps SkillManagementDeps) Handler {
	return &skillManagementHandler{inner: inner, deps: deps}
}

var skillProfile = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// Decode the small, flat protocol explicitly: encoding/json's struct decoder
// also accepts case-insensitive and duplicate keys, unlike the strict contract.
func skillManagementParams(verb string, raw json.RawMessage) (map[string]string, error) {
	fields := map[string]bool{"key": true, "profile": true}
	if verb != "skills.verify" && verb != "skills.native.verify" && verb != "skills.retention" && verb != "skills.maintenance.plan" {
		fields["operationId"] = true
	}
	if verb == "skills.plan" {
		fields["stationId"] = true
		fields["archiveSHA256"] = true
	}
	if verb == "skills.apply" {
		fields["stationId"] = true
		fields["expectedPlanDigest"] = true
	}
	if verb == "skills.native.plan" {
		fields["action"] = true
	}
	if verb == "skills.native.apply" {
		fields["expectedPlanDigest"] = true
	}
	invalid := fmt.Errorf("skills: invalid management params")
	if len(raw) > 8192 {
		return nil, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, invalid
	}
	params := map[string]string{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, invalid
		}
		key, ok := token.(string)
		if !ok || !fields[key] {
			return nil, invalid
		}
		if _, exists := params[key]; exists {
			return nil, invalid
		}
		var value string
		if err := decoder.Decode(&value); err != nil {
			return nil, invalid
		}
		params[key] = value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || decoder.Decode(new(any)) != io.EOF || len(params) != len(fields) {
		return nil, invalid
	}
	if !validArtifactStationKey(params["key"]) || len(params["profile"]) > 124 || !skillProfile.MatchString(params["profile"]) {
		return nil, invalid
	}
	if fields["operationId"] && !artifactOperation.MatchString(params["operationId"]) {
		return nil, invalid
	}
	if fields["stationId"] && !artifactSegment.MatchString(params["stationId"]) {
		return nil, invalid
	}
	for _, key := range []string{"archiveSHA256", "expectedPlanDigest"} {
		if fields[key] && !artifactDigest.MatchString(params[key]) {
			return nil, invalid
		}
	}
	if fields["action"] && params["action"] != "activate" && params["action"] != "deactivate" && params["action"] != "rollback" {
		return nil, invalid
	}
	return params, nil
}

func (h *skillManagementHandler) Handle(ctx context.Context, verb string, raw json.RawMessage, emit func(int, string, bool, string) error) (any, bool, error) {
	switch verb {
	case "skills.plan", "skills.rollback", "skills.apply", "skills.operation", "skills.verify", "skills.retention", "skills.maintenance.plan", "skills.native.plan", "skills.native.apply", "skills.native.operation", "skills.native.verify":
	default:
		return h.inner.Handle(ctx, verb, raw, emit)
	}
	params, err := skillManagementParams(verb, raw)
	if err != nil {
		return nil, false, err
	}
	if h.deps.NodeID == "" || h.deps.Resolve == nil {
		return nil, false, fmt.Errorf("skills: management unavailable")
	}
	if (verb == "skills.plan" || verb == "skills.apply") && h.deps.Fetch == nil {
		return nil, false, fmt.Errorf("skills: artifact transport unavailable")
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	workspace, harness, err := h.deps.Resolve(ctx, params["key"])
	if err != nil {
		return nil, false, err
	}
	binding := skills.InstallBinding{NodeID: h.deps.NodeID, StationKey: params["key"], Harness: harness, Profile: params["profile"], WorkspacePath: workspace}
	nativeMutation := verb == "skills.native.plan" || verb == "skills.native.apply"
	if nativeMutation && (h.deps.Workspaces == nil || h.deps.AuthorizeNative == nil) {
		return nil, false, fmt.Errorf("skills: native activation unavailable")
	}
	if nativeMutation {
		if err := h.deps.AuthorizeNative(ctx, params["key"], harness); err != nil {
			return nil, false, fmt.Errorf("skills: native activation refused: %w", err)
		}
	}
	var store *skills.InstallStore
	var archive []byte
	if verb == "skills.plan" {
		archive, err = h.deps.Fetch(ctx, SkillArtifactRequest{StationID: params["stationId"], StationKey: params["key"], OperationID: params["operationId"], ArchiveSHA256: params["archiveSHA256"]})
		if err != nil {
			return nil, false, err
		}
		// Reject a wrong package before claiming any on-disk namespace. The
		// store verifies it again when persisting the plan under its own lock.
		artifact, err := skills.ReadArtifact(ctx, bytes.NewReader(archive), params["archiveSHA256"], harness)
		if err != nil {
			return nil, false, err
		}
		if artifact.Manifest.Profile != binding.Profile {
			return nil, false, fmt.Errorf("skills: artifact profile mismatch")
		}
		store, err = skills.OpenInstallStore(binding)
	} else {
		store, err = skills.OpenExistingInstallStore(binding)
	}
	if errors.Is(err, skills.ErrInstallStoreNotFound) {
		if verb == "skills.operation" {
			return SkillOperationResult{}, false, nil
		}
		if verb == "skills.verify" {
			present := false
			now := time.Now().UTC().Format(time.RFC3339Nano)
			return SkillVerifyResult{NodeID: binding.NodeID, StationKey: binding.StationKey, Harness: harness, Profile: binding.Profile, Verification: skills.InstallVerification{
				Present: skills.Observation{Value: &present, ObservedAt: &now, Reason: "No managed namespace exists for this profile"},
				Loaded:  skills.Observation{Reason: "No harness registration or session inspection was performed"},
			}}, false, nil
		}
		if verb == "skills.retention" {
			return SkillRetentionResult{NodeID: binding.NodeID, StationKey: binding.StationKey, Harness: harness, Profile: binding.Profile, Retention: skills.RetentionInspection{NamespaceExists: false, OperationLimit: 256, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Limitation: "No managed namespace exists for this profile; no state was created while inspecting"}}, false, nil
		}
		if verb == "skills.maintenance.plan" {
			return nil, false, fmt.Errorf("skills: no managed namespace exists for maintenance")
		}
	}
	if err != nil {
		return nil, false, err
	}
	defer store.Close()
	switch verb {
	case "skills.plan":
		plan, err := store.PlanInstall(ctx, params["operationId"], bytes.NewReader(archive), params["archiveSHA256"])
		return plan, false, err
	case "skills.rollback":
		plan, err := store.PlanRollback(ctx, params["operationId"])
		return plan, false, err
	case "skills.operation":
		receipt, err := store.Operation(ctx, params["operationId"])
		if errors.Is(err, skills.ErrInstallOperationNotFound) {
			return SkillOperationResult{}, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		return SkillOperationResult{Receipt: &receipt}, false, nil
	case "skills.verify":
		verification, err := store.Verify(ctx)
		return SkillVerifyResult{NodeID: binding.NodeID, StationKey: binding.StationKey, Harness: harness, Profile: binding.Profile, Verification: verification}, false, err
	case "skills.retention":
		retention, err := store.Retention(ctx)
		return SkillRetentionResult{NodeID: binding.NodeID, StationKey: binding.StationKey, Harness: harness, Profile: binding.Profile, Retention: retention}, false, err
	case "skills.maintenance.plan":
		plan, err := store.PlanMaintenance(ctx)
		return SkillMaintenanceResult{NodeID: binding.NodeID, StationKey: binding.StationKey, Harness: harness, Profile: binding.Profile, Maintenance: plan}, false, err
	case "skills.apply":
		receipt, err := store.Operation(ctx, params["operationId"])
		if err != nil {
			return nil, false, err
		}
		if receipt.Plan.PlanDigest != params["expectedPlanDigest"] {
			return nil, false, fmt.Errorf("%w: reviewed plan digest differs", skills.ErrInstallConflict)
		}
		var reader io.Reader
		if receipt.Plan.Action == "install" && receipt.Phase != "applied" {
			archive, err = h.deps.Fetch(ctx, SkillArtifactRequest{StationID: params["stationId"], StationKey: params["key"], OperationID: params["operationId"], ArchiveSHA256: receipt.Plan.After.ArchiveSHA256})
			if err != nil {
				return nil, false, err
			}
			reader = bytes.NewReader(archive)
		}
		applied, err := store.ApplyReviewed(ctx, params["operationId"], params["expectedPlanDigest"], reader)
		return applied, false, err
	case "skills.native.plan":
		plan, err := store.PlanPlacement(ctx, params["operationId"], params["action"])
		return plan, false, err
	case "skills.native.operation":
		receipt, err := store.PlacementOperation(ctx, params["operationId"])
		if errors.Is(err, os.ErrNotExist) {
			return SkillNativeOperationResult{}, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		return SkillNativeOperationResult{Receipt: &receipt}, false, nil
	case "skills.native.apply":
		receipt, err := store.ApplyPlacementWhenIdle(ctx, params["operationId"], params["expectedPlanDigest"], h.deps.Workspaces)
		return receipt, false, err
	case "skills.native.verify":
		verification, err := store.VerifyPlacement(ctx)
		if err == nil && h.deps.VerifyNative != nil && len(verification.DiscoveryNames) != 0 {
			loaded, verifyErr := h.deps.VerifyNative(ctx, params["key"], harness, verification.DiscoveryNames)
			if verifyErr != nil {
				loaded = skills.Observation{Reason: "Native loading verification failed: " + boundedNativeVerificationReason(verifyErr.Error())}
			}
			verification.Loaded = loaded
		}
		return SkillNativeVerifyResult{NodeID: binding.NodeID, StationKey: binding.StationKey, Harness: harness, Profile: binding.Profile, Verification: verification}, false, err
	}
	return nil, false, fmt.Errorf("skills: unknown management verb")
}

func boundedNativeVerificationReason(reason string) string {
	if len(reason) > 512 {
		return reason[:512]
	}
	return reason
}

func (h *skillManagementHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if handler, ok := h.inner.(FrameHandler); ok {
		return handler.HandleFrame(frameType, id, raw)
	}
	return nil
}
