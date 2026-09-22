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
	if !operationPattern.MatchString(h.OperationID) || !validGeneration(h.Current) || !validGeneration(h.Previous) || (h.NativeLayout != "" && !s.isDirectLayout(h.NativeLayout)) {
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
	if p.SchemaVersion != 1 || p.OperationID != id || p.Binding != s.binding || p.TargetPath != filepath.Join(s.binding.WorkspacePath, target) || p.PlanDigest != placementHash(p) || !validGeneration(p.Before) || !validGeneration(p.After) || !digestPattern.MatchString(p.ExpectedHead) || !digestPattern.MatchString(p.ExpectedInstallationHead) || !digestPattern.MatchString(p.RepositoryIdentity) || !filepath.IsAbs(p.RepositoryPath) || p.Activation != placementActivation || (p.NativeLayout != "" && !s.isDirectLayout(p.NativeLayout)) {
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
	if err = s.verifyPlaced(ctx, workspace, target, head.Current, head.NativeLayout); err != nil {
		return PlacementPlan{}, err
	}
	if err = s.placementCollisions(ctx, repo, filepath.Join(s.binding.WorkspacePath, target), s.placedNames(ctx, head.Current), afterManifest); err != nil {
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
		if _, direct := s.directLayout(); direct && (len(afterManifest.Skills) != 1 || afterManifest.Skills[0].ID != "sjl-"+s.binding.Profile) {
			return PlacementPlan{}, fmt.Errorf("skills: Codex native placement requires exactly one plain skill")
		}
		for _, skill := range afterManifest.Skills {
			name := skill.ID
			names = append(names, name)
		}
	}
	sort.Strings(names)
	layout := ""
	changes := installDiff(beforeManifest, afterManifest)
	if want, direct := s.directLayout(); direct {
		layout = want
		changes, err = directPlacementDiff(beforeManifest, afterManifest, head.NativeLayout, want)
		if err != nil {
			return PlacementPlan{}, err
		}
	}
	p := PlacementPlan{SchemaVersion: 1, OperationID: id, Action: action, Binding: s.binding, RepositoryPath: repo, RepositoryIdentity: identity, ExpectedInstallationHead: hashJSON(managed), ExpectedHead: hashJSON(head), Before: head.Current, After: after, NativeLayout: layout, TargetPath: filepath.Join(s.binding.WorkspacePath, target), Changes: changes, DiscoveryNames: names, Activation: placementActivation, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
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
		if !sameGeneration(head.Current, p.After) || head.NativeLayout != p.NativeLayout {
			return fmt.Errorf("%w: native head does not match operation", ErrInstallConflict)
		}
		if err = s.verifyPlaced(ctx, workspace, target, p.After, p.NativeLayout); err != nil {
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
		if err = s.verifyPlaced(ctx, workspace, target, p.Before, head.NativeLayout); err != nil {
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
	if err = s.placementCollisions(ctx, p.RepositoryPath, p.TargetPath, s.placedNames(ctx, p.Before), after); err != nil {
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
	desired := installHead{OperationID: p.OperationID, Current: p.After, Previous: p.Before, NativeLayout: p.NativeLayout}
	if sameGeneration(p.Before, p.After) {
		desired.Previous = head.Previous // repeated placement must preserve useful rollback history
	}
	if sameGeneration(p.Before, p.After) && head.NativeLayout == p.NativeLayout {
		if err = s.verifyPlaced(ctx, workspace, target, p.Before, head.NativeLayout); err != nil {
			return err
		}
	} else {
		if err = s.publishPlacement(ctx, r, workspace, target, before, after, head.NativeLayout); err != nil {
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
	if err = s.verifyPlaced(ctx, workspace, target, head.Current, head.NativeLayout); err != nil {
		return PlacementVerification{}, err
	}
	manifest, err := s.verifyGeneration(ctx, head.Current)
	if err != nil {
		return PlacementVerification{}, err
	}
	names := []string{}
	if want, direct := s.directLayout(); manifest != nil && (!direct || head.NativeLayout == want) {
		if direct && (len(manifest.Skills) != 1 || manifest.Skills[0].ID != "sjl-"+s.binding.Profile) {
			return PlacementVerification{}, fmt.Errorf("skills: Codex native placement identity differs")
		}
		for _, skill := range manifest.Skills {
			name := skill.ID
			names = append(names, name)
		}
		sort.Strings(names)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	present := head.Current != nil
	reason := "Verified owned files in the native project discovery root"
	// Only Codex can hold a placement recorded before its direct layout was
	// corrected. Claude's grouped layout was probed and never published, so it
	// has no legacy generation to migrate.
	if s.binding.Harness == "codex" && head.Current != nil && head.NativeLayout == "" {
		reason = "Verified legacy grouped files; activate again to publish the direct Codex discovery layout"
	}
	return PlacementVerification{Current: head.Current, Path: filepath.Join(s.binding.WorkspacePath, target), DiscoveryNames: names, Present: Observation{Value: &present, ObservedAt: &now, Reason: reason}, Loaded: Observation{Reason: "Native eligibility, project trust and session loading were not queried"}}, nil
}

// AbsentPlacementNames reports the native discovery names of the generation
// this station last placed, for the case where no placement is present. A
// fresh-session probe needs them to establish the negative a removal claims:
// file absence alone is not loading evidence, and only a new session that does
// not advertise those exact names closes that gate.
//
// The names are read from the recorded head, never invented. When no such
// generation can be verified the caller has nothing honest to check, so the
// returned names are empty and the returned reason names the condition; that
// case is an unknown loading observation, never a negative one.
func (s *InstallStore) AbsentPlacementNames(ctx context.Context) ([]string, string, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return nil, "", err
	}
	defer unlock()
	head, err := s.placementHead()
	if err != nil {
		return nil, "", err
	}
	if head.Current != nil {
		return nil, "A native placement is present, so its own discovery names apply", nil
	}
	const unqueried = "Native session loading was not queried: "
	if head.OperationID == "" || head.Previous == nil {
		return nil, unqueried + "no previous verified native generation records the skill names a fresh session must no longer advertise", nil
	}
	// The Codex direct layout decides what a session actually advertises, so a
	// head recorded under the legacy grouped layout cannot name the commands.
	if want, direct := s.directLayout(); direct && head.NativeLayout != want {
		return nil, unqueried + "the last native placement used the legacy grouped layout, whose advertised command names are not established", nil
	}
	manifest, err := s.verifyGeneration(ctx, head.Previous)
	if err != nil {
		return nil, unqueried + "the last placed native generation could not be verified, so the skill names to check are not established", nil
	}
	if manifest == nil {
		return nil, unqueried + "the last placed native generation carries no manifest to name the skills to check", nil
	}
	if _, direct := s.directLayout(); direct && (len(manifest.Skills) != 1 || manifest.Skills[0].ID != "sjl-"+s.binding.Profile) {
		return nil, unqueried + "the last placed native generation does not match this station's Codex placement identity", nil
	}
	names := make([]string, 0, len(manifest.Skills))
	for _, skill := range manifest.Skills {
		names = append(names, skill.ID)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return nil, unqueried + "the last placed native generation names no skills to check", nil
	}
	return names, "", nil
}
