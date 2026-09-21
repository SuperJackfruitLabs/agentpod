package skills

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

func placementHash(p PlacementPlan) string { p.PlanDigest = ""; return hashJSON(p) }
func sameGeneration(a, b *Generation) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
func (s *InstallStore) placementHead() (installHead, error) {
	var h installHead
	if err := s.readJSON("native/head.json", &h); errors.Is(err, os.ErrNotExist) {
		return h, nil
	} else if err != nil {
		return h, err
	}
	if !operationPattern.MatchString(h.OperationID) || !validGeneration(h.Current) || !validGeneration(h.Previous) {
		return h, fmt.Errorf("%w: invalid native head", ErrInstallConflict)
	}
	return h, nil
}
func (s *InstallStore) activePlacement() (string, error) {
	var active struct {
		OperationID string `json:"operationId"`
	}
	err := s.readJSON("native/active.json", &active)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !operationPattern.MatchString(active.OperationID) {
		return "", fmt.Errorf("%w: invalid native journal", ErrInstallConflict)
	}
	return active.OperationID, nil
}
func (s *InstallStore) placementOperation(id string) (PlacementReceipt, error) {
	var receipt PlacementReceipt
	if !operationPattern.MatchString(id) {
		return receipt, fmt.Errorf("skills: invalid native operation ID")
	}
	if err := s.readJSON("native/operations/"+id+".json", &receipt); err != nil {
		return receipt, err
	}
	p := receipt.Plan
	target, err := s.placementTarget()
	if err != nil {
		return receipt, err
	}
	if p.SchemaVersion != 1 || p.OperationID != id || p.Binding != s.binding || p.TargetPath != filepath.Join(s.binding.WorkspacePath, target) || p.PlanDigest != placementHash(p) || !validGeneration(p.Before) || !validGeneration(p.After) || !digestPattern.MatchString(p.ExpectedHead) || !digestPattern.MatchString(p.ExpectedInstallationHead) || !digestPattern.MatchString(p.RepositoryIdentity) || !filepath.IsAbs(p.RepositoryPath) || p.Activation != placementActivation {
		return receipt, fmt.Errorf("%w: invalid native operation binding", ErrInstallConflict)
	}
	if p.Action != "activate" && p.Action != "deactivate" && p.Action != "rollback" || p.Action == "activate" && p.After == nil || p.Action == "deactivate" && p.After != nil {
		return receipt, fmt.Errorf("skills: invalid native action")
	}
	if _, err = time.Parse(time.RFC3339Nano, p.CreatedAt); err != nil {
		return receipt, err
	}
	for _, entries := range [][]string{p.Changes.Added, p.Changes.Removed, p.Changes.Changed} {
		if len(entries) > maxArtifactFiles {
			return receipt, fmt.Errorf("skills: oversized native diff")
		}
		for _, name := range entries {
			if !artifactPath(name) {
				return receipt, fmt.Errorf("skills: invalid native diff")
			}
		}
	}
	switch receipt.Phase {
	case "planned", "staging", "switching", "conflict":
		if receipt.CompletedAt != nil {
			return receipt, fmt.Errorf("skills: incomplete native receipt")
		}
	case "applied":
		if receipt.CompletedAt == nil {
			return receipt, fmt.Errorf("skills: native completion time missing")
		}
	default:
		return receipt, fmt.Errorf("skills: invalid native phase")
	}
	return receipt, nil
}
func (s *InstallStore) savePlacement(r *PlacementReceipt, phase string) error {
	r.Phase = phase
	r.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if phase == "applied" {
		now := r.UpdatedAt
		r.CompletedAt = &now
		r.Error = nil
	}
	return s.writeJSON("native/operations/"+r.Plan.OperationID+".json", r)
}

// PlanPlacement is an internal primitive for an explicitly quiescent Git
// workspace. The caller must hold a session guard before exposing application
// remotely. This method does not establish version compatibility or loading.
func (s *InstallStore) PlanPlacement(ctx context.Context, id, action string) (PlacementPlan, error) {
	target, err := s.placementTarget()
	if err != nil {
		return PlacementPlan{}, err
	}
	if !operationPattern.MatchString(id) || (action != "activate" && action != "deactivate" && action != "rollback") {
		return PlacementPlan{}, fmt.Errorf("skills: invalid native request")
	}
	repo, identity, release, err := s.placementLock(ctx)
	if err != nil {
		return PlacementPlan{}, err
	}
	defer release()
	unlock, err := s.lock(ctx)
	if err != nil {
		return PlacementPlan{}, err
	}
	defer unlock()
	if existing, err := s.placementOperation(id); err == nil {
		if existing.Plan.Action != action {
			return PlacementPlan{}, fmt.Errorf("%w: native operation already bound", ErrInstallConflict)
		}
		return existing.Plan, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return PlacementPlan{}, err
	}
	if fence, err := readPlacementAdmission(repo); err != nil {
		return PlacementPlan{}, err
	} else if fence != nil {
		return PlacementPlan{}, fmt.Errorf("%w: repository native admission requires recovery", ErrInstallConflict)
	}
	if active, err := s.activePlacement(); err != nil {
		return PlacementPlan{}, err
	} else if active != "" {
		return PlacementPlan{}, fmt.Errorf("%w: native operation requires recovery", ErrInstallConflict)
	}
	head, err := s.placementHead()
	if err != nil {
		return PlacementPlan{}, err
	}
	managed, err := s.head()
	if err != nil {
		return PlacementPlan{}, err
	}
	after := managed.Current
	if action == "deactivate" {
		after = nil
	}
	if action == "rollback" {
		if head.OperationID == "" {
			return PlacementPlan{}, fmt.Errorf("skills: no native placement history")
		}
		after = head.Previous
	}
	if action == "activate" && after == nil {
		return PlacementPlan{}, fmt.Errorf("skills: no managed generation selected")
	}
	beforeManifest, err := s.verifyGeneration(ctx, head.Current)
	if err != nil {
		return PlacementPlan{}, err
	}
	afterManifest, err := s.verifyGeneration(ctx, after)
	if err != nil {
		return PlacementPlan{}, err
	}
	if err = s.placementContent(ctx, after, afterManifest); err != nil {
		return PlacementPlan{}, err
	}
	workspace, err := s.placementWorkspace()
	if err != nil {
		return PlacementPlan{}, err
	}
	defer workspace.Close()
	if err = s.verifyPlaced(ctx, workspace, target, head.Current); err != nil {
		return PlacementPlan{}, err
	}
	if err = s.placementCollisions(ctx, repo, filepath.Join(s.binding.WorkspacePath, target), afterManifest); err != nil {
		return PlacementPlan{}, err
	}
	for _, dir := range []string{"native/operations", "native/staging", "native/backups"} {
		if err = makeDirs(s.root, dir); err != nil {
			return PlacementPlan{}, err
		}
	}
	directory, err := s.root.Open("native/operations")
	if err != nil {
		return PlacementPlan{}, err
	}
	entries, err := directory.ReadDir(257)
	directory.Close()
	if err != nil && err != io.EOF {
		return PlacementPlan{}, err
	}
	limit := 256
	if action == "activate" {
		limit = 255
	}
	if len(entries) >= limit {
		return PlacementPlan{}, fmt.Errorf("skills: native operation retention limit reached")
	}
	names := []string{}
	if afterManifest != nil {
		for _, skill := range afterManifest.Skills {
			name := skill.ID
			if s.binding.Harness == "codex" {
				name = afterManifest.Name + ":" + name
			}
			names = append(names, name)
		}
	}
	sort.Strings(names)
	p := PlacementPlan{SchemaVersion: 1, OperationID: id, Action: action, Binding: s.binding, RepositoryPath: repo, RepositoryIdentity: identity, ExpectedInstallationHead: hashJSON(managed), ExpectedHead: hashJSON(head), Before: head.Current, After: after, TargetPath: filepath.Join(s.binding.WorkspacePath, target), Changes: installDiff(beforeManifest, afterManifest), DiscoveryNames: names, Activation: placementActivation, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	p.PlanDigest = placementHash(p)
	r := PlacementReceipt{Plan: p}
	if err = s.savePlacement(&r, "planned"); err != nil {
		return PlacementPlan{}, err
	}
	return p, nil
}
func (s *InstallStore) PlacementOperation(ctx context.Context, id string) (PlacementReceipt, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return PlacementReceipt{}, err
	}
	defer unlock()
	return s.placementOperation(id)
}
func (s *InstallStore) ApplyPlacement(ctx context.Context, id, digest string) (PlacementReceipt, error) {
	repo, identity, release, err := s.placementLock(ctx)
	if err != nil {
		return PlacementReceipt{}, err
	}
	defer release()
	unlock, err := s.lock(ctx)
	if err != nil {
		return PlacementReceipt{}, err
	}
	defer unlock()
	receipt, err := s.placementOperation(id)
	if err != nil {
		return receipt, err
	}
	if receipt.Plan.PlanDigest != digest || receipt.Plan.RepositoryPath != repo || receipt.Plan.RepositoryIdentity != identity {
		return receipt, fmt.Errorf("%w: native reviewed plan or repository changed", ErrInstallConflict)
	}
	fence, err := readPlacementAdmission(repo)
	if err != nil {
		return receipt, err
	}
	if fence != nil && *fence != admissionFor(receipt.Plan) {
		return receipt, fmt.Errorf("%w: another native operation owns repository admission", ErrInstallConflict)
	}
	if receipt.Phase == "applied" {
		active, err := s.activePlacement()
		if err != nil {
			return receipt, err
		}
		if active != "" && active != id {
			return receipt, fmt.Errorf("%w: another native journal requires recovery", ErrInstallConflict)
		}
		if active == id || fence != nil {
			head, err := s.placementHead()
			if err != nil {
				return receipt, err
			}
			if head.OperationID != id || !sameGeneration(head.Current, receipt.Plan.After) {
				return receipt, fmt.Errorf("%w: completed native journal differs from head", ErrInstallConflict)
			}
			if active == id {
				if err = s.root.Remove("native/active.json"); err != nil {
					return receipt, err
				}
				if err = syncDir(s.root, "native"); err != nil {
					return receipt, err
				}
			}
		}
		return receipt, s.finishPlacementAdmission(receipt.Plan) // historical receipt; fresh verification checks later edits
	}
	err = s.applyPlacement(ctx, &receipt, fence != nil)
	if errors.Is(err, ErrInstallConflict) {
		message := err.Error()
		if len(message) > 2048 {
			message = message[:2048]
		}
		receipt.Error = &message
		if saveErr := s.savePlacement(&receipt, "conflict"); saveErr != nil {
			return receipt, fmt.Errorf("%v; saving native conflict: %w", err, saveErr)
		}
	}
	if err == nil {
		err = s.finishPlacementAdmission(receipt.Plan)
	}
	return receipt, err
}
func (s *InstallStore) applyPlacement(ctx context.Context, r *PlacementReceipt, admitted bool) error {
	p := r.Plan
	active, err := s.activePlacement()
	if err != nil {
		return err
	}
	if active != "" && active != p.OperationID {
		return fmt.Errorf("%w: another native operation needs recovery", ErrInstallConflict)
	}
	head, err := s.placementHead()
	if err != nil {
		return err
	}
	target, _ := s.placementTarget()
	workspace, err := s.placementWorkspace()
	if err != nil {
		return err
	}
	defer workspace.Close()
	// Completion can be interrupted between the head write, receipt and journal cleanup.
	if head.OperationID == p.OperationID {
		if !sameGeneration(head.Current, p.After) {
			return fmt.Errorf("%w: native head does not match operation", ErrInstallConflict)
		}
		if err = s.verifyPlaced(ctx, workspace, target, p.After); err != nil {
			return err
		}
		if err := s.beginPlacementAdmission(p); err != nil {
			return err
		}
		return s.finishPlacement(r)
	}
	if hashJSON(head) != p.ExpectedHead {
		return fmt.Errorf("%w: stale native placement plan", ErrInstallConflict)
	}
	if active == "" {
		managed, err := s.head()
		if err != nil {
			return err
		}
		if !admitted && hashJSON(managed) != p.ExpectedInstallationHead {
			return fmt.Errorf("%w: managed selection changed", ErrInstallConflict)
		}
		if err = s.verifyPlaced(ctx, workspace, target, p.Before); err != nil {
			return err
		}
	}
	before, err := s.verifyGeneration(ctx, p.Before)
	if err != nil {
		return err
	}
	after, err := s.verifyGeneration(ctx, p.After)
	if err != nil {
		return err
	}
	if err = s.placementContent(ctx, p.After, after); err != nil {
		return err
	}
	if err = s.placementCollisions(ctx, p.RepositoryPath, p.TargetPath, after); err != nil {
		return err
	}
	if err := s.beginPlacementAdmission(p); err != nil {
		return err
	}
	if active == "" {
		if err = s.writeJSON("native/active.json", map[string]string{"operationId": p.OperationID}); err != nil {
			return err
		}
	}
	if err = s.savePlacement(r, "staging"); err != nil {
		return err
	}
	if err = s.checkpoint("native-journal"); err != nil {
		return err
	}
	desired := installHead{OperationID: p.OperationID, Current: p.After, Previous: p.Before}
	if sameGeneration(p.Before, p.After) {
		desired.Previous = head.Previous // repeated placement must preserve useful rollback history
		if err = s.verifyPlaced(ctx, workspace, target, p.Before); err != nil {
			return err
		}
	} else {
		if err = s.publishPlacement(ctx, r, workspace, target, before, after); err != nil {
			return err
		}
	}
	if err = s.writeJSON("native/head.json", desired); err != nil {
		return err
	}
	if err = s.checkpoint("native-head"); err != nil {
		return err
	}
	return s.finishPlacement(r)
}
func (s *InstallStore) finishPlacement(r *PlacementReceipt) error {
	if err := s.savePlacement(r, "applied"); err != nil {
		return err
	}
	if err := s.checkpoint("native-receipt"); err != nil {
		return err
	}
	if err := s.root.Remove("native/active.json"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(s.root, "native")
}
func (s *InstallStore) VerifyPlacement(ctx context.Context) (PlacementVerification, error) {
	target, err := s.placementTarget()
	if err != nil {
		return PlacementVerification{}, err
	}
	unlock, err := s.lock(ctx)
	if err != nil {
		return PlacementVerification{}, err
	}
	defer unlock()
	repo, _, err := s.placementRepository()
	if err != nil {
		return PlacementVerification{}, err
	}
	if fence, err := readPlacementAdmission(repo); err != nil {
		return PlacementVerification{}, err
	} else if fence != nil {
		return PlacementVerification{}, fmt.Errorf("%w: repository native admission requires recovery", ErrInstallConflict)
	}
	if active, err := s.activePlacement(); err != nil {
		return PlacementVerification{}, err
	} else if active != "" {
		return PlacementVerification{}, fmt.Errorf("%w: native publication needs recovery", ErrInstallConflict)
	}
	head, err := s.placementHead()
	if err != nil {
		return PlacementVerification{}, err
	}
	workspace, err := s.placementWorkspace()
	if err != nil {
		return PlacementVerification{}, err
	}
	defer workspace.Close()
	if err = s.verifyPlaced(ctx, workspace, target, head.Current); err != nil {
		return PlacementVerification{}, err
	}
	manifest, err := s.verifyGeneration(ctx, head.Current)
	if err != nil {
		return PlacementVerification{}, err
	}
	names := []string{}
	if manifest != nil {
		for _, skill := range manifest.Skills {
			name := skill.ID
			if s.binding.Harness == "codex" {
				name = manifest.Name + ":" + name
			}
			names = append(names, name)
		}
		sort.Strings(names)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	present := head.Current != nil
	return PlacementVerification{Current: head.Current, Path: filepath.Join(s.binding.WorkspacePath, target), DiscoveryNames: names, Present: Observation{Value: &present, ObservedAt: &now, Reason: "Verified owned files in the native project discovery root"}, Loaded: Observation{Reason: "Native eligibility, project trust and session loading were not queried"}}, nil
}
