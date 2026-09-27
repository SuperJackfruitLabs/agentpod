package skills

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

type installHead struct {
	OperationID  string      `json:"operationId"`
	Current      *Generation `json:"current"`
	Previous     *Generation `json:"previous"`
	NativeLayout string      `json:"nativeLayout,omitempty"`
}

// RetentionInspection is observational accounting for a single managed
// namespace. It deliberately does not prune anything: completed receipts and
// generations are recovery evidence, and an operator must inspect them before
// a future retention policy may remove them.
type RetentionInspection struct {
	NamespaceExists  bool   `json:"namespaceExists"`
	Operations       int    `json:"operations"`
	OperationLimit   int    `json:"operationLimit"`
	Generations      int    `json:"generations"`
	Staging          int    `json:"staging"`
	Pending          int    `json:"pending"`
	NativeOperations int    `json:"nativeOperations"`
	NativeStaging    int    `json:"nativeStaging"`
	NativeBackups    int    `json:"nativeBackups"`
	ObservedAt       string `json:"observedAt"`
	Limitation       string `json:"limitation"`
}

func retentionCount(root *os.Root, name string, limit int) (int, error) {
	directory, err := root.Open(name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	entries, err := directory.ReadDir(limit + 1)
	closeErr := directory.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, err
	}
	if closeErr != nil {
		return 0, closeErr
	}
	if len(entries) > limit {
		return 0, fmt.Errorf("%w: retained %s exceeds its limit", ErrInstallConflict, name)
	}
	return len(entries), nil
}

// Retention reports bounded node-owned state without creating a namespace or
// following user-controlled paths. It is intentionally separate from verify:
// correct current files do not make stale recovery evidence disposable.
func (s *InstallStore) Retention(ctx context.Context) (RetentionInspection, error) {
	if err := ctx.Err(); err != nil {
		return RetentionInspection{}, err
	}
	result := RetentionInspection{
		NamespaceExists: true,
		OperationLimit:  256,
		ObservedAt:      time.Now().UTC().Format(time.RFC3339Nano),
		Limitation:      "Read-only accounting only; retained operations, generations, and interrupted writes are preserved until a separately reviewed maintenance policy exists",
	}
	var err error
	for _, target := range []struct {
		name  string
		limit int
		into  *int
	}{
		{"operations", 256, &result.Operations},
		{"generations", 256, &result.Generations},
		{"staging", 16, &result.Staging},
		{"pending", 16, &result.Pending},
		{"native/operations", 256, &result.NativeOperations},
		{"native/staging", 16, &result.NativeStaging},
		{"native/backups", 256, &result.NativeBackups},
	} {
		*target.into, err = retentionCount(s.root, target.name, target.limit)
		if err != nil {
			return RetentionInspection{}, err
		}
	}
	return result, nil
}

func (s *InstallStore) head() (installHead, error) {
	var head installHead
	err := s.readJSON("head.json", &head)
	if errors.Is(err, os.ErrNotExist) {
		return head, nil
	}
	if err != nil {
		return head, err
	}
	if !operationPattern.MatchString(head.OperationID) || !validGeneration(head.Current) || !validGeneration(head.Previous) {
		return head, fmt.Errorf("skills: invalid installation head")
	}
	return head, nil
}
func (s *InstallStore) generationPath(g *Generation) *string {
	if g == nil {
		return nil
	}
	target := filepath.Join(s.directory, "generations", g.Generation)
	return &target
}
func planHash(plan InstallPlan) string { plan.PlanDigest = ""; return hashJSON(plan) }
func operationPath(id string) (string, error) {
	if !operationPattern.MatchString(id) {
		return "", fmt.Errorf("skills: invalid operation ID")
	}
	return "operations/" + id + ".json", nil
}
func (s *InstallStore) operation(id string) (InstallReceipt, error) {
	var receipt InstallReceipt
	relative, err := operationPath(id)
	if err != nil {
		return receipt, err
	}
	if err := s.readJSON(relative, &receipt); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if parentErr := checkComponents(s.root, "operations"); parentErr != nil {
				return receipt, fmt.Errorf("%w: missing operations directory", ErrInstallConflict)
			}
			return receipt, fmt.Errorf("%w: %w", ErrInstallOperationNotFound, err)
		}
		return receipt, err
	}
	p := receipt.Plan
	target := s.generationPath(p.After)
	if (target == nil) != (p.TargetPath == nil) || (target != nil && (*target != *p.TargetPath || len(*target) > 4096)) {
		return receipt, fmt.Errorf("%w: operation destination differs", ErrInstallConflict)
	}
	if p.SchemaVersion != 1 || p.OperationID != id || p.Binding != s.binding || p.PlanDigest != planHash(p) || !digestPattern.MatchString(p.ExpectedHead) || !validGeneration(p.Before) || !validGeneration(p.After) || p.Activation != "pending" || (p.Action != "install" && p.Action != "rollback") || (p.Action == "install" && (p.After == nil || p.After.Generation != id)) {
		return receipt, fmt.Errorf("%w: invalid or foreign operation", ErrInstallConflict)
	}
	if _, err := time.Parse(time.RFC3339Nano, p.CreatedAt); err != nil {
		return receipt, fmt.Errorf("skills: invalid plan time")
	}
	for _, paths := range [][]string{p.Changes.Added, p.Changes.Removed, p.Changes.Changed} {
		if len(paths) > maxArtifactFiles {
			return receipt, fmt.Errorf("skills: oversized plan")
		}
		for _, name := range paths {
			if !artifactPath(name) {
				return receipt, fmt.Errorf("skills: unsafe plan diff")
			}
		}
	}
	switch receipt.Phase {
	case "planned", "staging", "switching", "conflict":
		if receipt.CompletedAt != nil {
			return receipt, fmt.Errorf("skills: incomplete operation claims completion")
		}
	case "applied":
		if receipt.CompletedAt == nil {
			return receipt, fmt.Errorf("skills: applied operation lacks receipt time")
		}
	default:
		return receipt, fmt.Errorf("skills: invalid operation phase")
	}
	return receipt, nil
}
func (s *InstallStore) save(receipt *InstallReceipt, phase string) error {
	receipt.Phase = phase
	receipt.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if phase == "applied" {
		value := receipt.UpdatedAt
		receipt.CompletedAt = &value
		receipt.Error = nil
	}
	relative, err := operationPath(receipt.Plan.OperationID)
	if err != nil {
		return err
	}
	return s.writeJSON(relative, receipt)
}
func (s *InstallStore) newPlan(ctx context.Context, id, action string, artifact *Artifact) (InstallPlan, error) {
	if _, err := operationPath(id); err != nil {
		return InstallPlan{}, err
	}
	if existing, err := s.operation(id); err == nil {
		if existing.Plan.Action != action || (artifact != nil && (existing.Plan.After == nil || existing.Plan.After.ArchiveSHA256 != artifact.ArchiveSHA256)) {
			return InstallPlan{}, fmt.Errorf("%w: operation ID already bound", ErrInstallConflict)
		}
		return existing.Plan, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return InstallPlan{}, err
	}
	directory, err := s.root.Open("operations")
	if err != nil {
		return InstallPlan{}, err
	}
	entries, err := directory.ReadDir(257)
	directory.Close()
	if err != nil && err != io.EOF {
		return InstallPlan{}, err
	}
	limit := 256
	if action == "install" {
		limit = 255
	} // keep one record available for rollback
	if len(entries) >= limit {
		return InstallPlan{}, fmt.Errorf("skills: operation retention limit reached")
	}
	head, err := s.head()
	if err != nil {
		return InstallPlan{}, err
	}
	before, err := s.verifyGeneration(ctx, head.Current)
	if err != nil {
		return InstallPlan{}, err
	}
	after := head.Previous
	var manifest *BundleManifest
	if action == "install" {
		if artifact.Manifest.Profile != s.binding.Profile {
			return InstallPlan{}, fmt.Errorf("skills: artifact profile mismatch")
		}
		after = &Generation{Generation: id, ArchiveSHA256: artifact.ArchiveSHA256, BundleDigest: artifact.Manifest.Digest}
		manifest = &artifact.Manifest
	} else {
		if head.OperationID == "" {
			return InstallPlan{}, fmt.Errorf("skills: no installation history")
		}
		manifest, err = s.verifyGeneration(ctx, after)
		if err != nil {
			return InstallPlan{}, err
		}
	}
	plan := InstallPlan{SchemaVersion: 1, OperationID: id, Action: action, Binding: s.binding, ExpectedHead: hashJSON(head), Before: head.Current, After: after, Changes: installDiff(before, manifest), Activation: "pending", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	plan.TargetPath = s.generationPath(plan.After)
	if plan.TargetPath != nil && len(*plan.TargetPath) > 4096 {
		return InstallPlan{}, fmt.Errorf("skills: installation destination exceeds limit")
	}
	plan.PlanDigest = planHash(plan)
	receipt := InstallReceipt{Plan: plan}
	if err := s.save(&receipt, "planned"); err != nil {
		return InstallPlan{}, err
	}
	return plan, nil
}
func (s *InstallStore) PlanInstall(ctx context.Context, id string, archive io.Reader, pin string) (InstallPlan, error) {
	if archive == nil {
		return InstallPlan{}, fmt.Errorf("skills: artifact required")
	}
	artifact, err := ReadArtifact(ctx, archive, pin, s.binding.Harness)
	if err != nil {
		return InstallPlan{}, err
	}
	unlock, err := s.lock(ctx)
	if err != nil {
		return InstallPlan{}, err
	}
	defer unlock()
	return s.newPlan(ctx, id, "install", artifact)
}
func (s *InstallStore) PlanRollback(ctx context.Context, id string) (InstallPlan, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return InstallPlan{}, err
	}
	defer unlock()
	return s.newPlan(ctx, id, "rollback", nil)
}
func (s *InstallStore) Operation(ctx context.Context, id string) (InstallReceipt, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return InstallReceipt{}, err
	}
	defer unlock()
	return s.operation(id)
}
func (s *InstallStore) Apply(ctx context.Context, id string, archive io.Reader) (InstallReceipt, error) {
	return s.applyOperation(ctx, id, archive, nil)
}

// ApplyReviewed checks the caller's reviewed plan under the same lock as the
// head switch. A digest mismatch never changes the operation or installation.
func (s *InstallStore) ApplyReviewed(ctx context.Context, id, expectedPlanDigest string, archive io.Reader) (InstallReceipt, error) {
	return s.applyOperation(ctx, id, archive, &expectedPlanDigest)
}

func (s *InstallStore) applyOperation(ctx context.Context, id string, archive io.Reader, expectedPlanDigest *string) (InstallReceipt, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return InstallReceipt{}, err
	}
	defer unlock()
	receipt, err := s.operation(id)
	if err != nil {
		return receipt, err
	}
	if expectedPlanDigest != nil && *expectedPlanDigest != receipt.Plan.PlanDigest {
		return receipt, fmt.Errorf("%w: reviewed plan digest differs", ErrInstallConflict)
	}
	if receipt.Phase == "applied" {
		return receipt, nil
	}
	err = s.apply(ctx, &receipt, archive)
	if errors.Is(err, ErrInstallConflict) {
		message := err.Error()
		receipt.Error = &message
		if saveErr := s.save(&receipt, "conflict"); saveErr != nil {
			return receipt, fmt.Errorf("%v; saving conflict: %w", err, saveErr)
		}
	}
	return receipt, err
}
func (s *InstallStore) apply(ctx context.Context, receipt *InstallReceipt, archive io.Reader) error {
	plan := receipt.Plan
	head, err := s.head()
	if err != nil {
		return err
	}
	desired := installHead{OperationID: plan.OperationID, Current: plan.After, Previous: plan.Before}
	if hashJSON(head) == hashJSON(desired) {
		if _, err := s.verifyGeneration(ctx, plan.After); err != nil {
			return err
		}
		return s.save(receipt, "applied") // interrupted after the atomic head switch
	}
	if hashJSON(head) != plan.ExpectedHead {
		return fmt.Errorf("%w: stale installation plan", ErrInstallConflict)
	}
	if _, err := s.verifyGeneration(ctx, head.Current); err != nil {
		return err
	}
	if plan.Action == "install" {
		if archive == nil {
			return fmt.Errorf("skills: pinned artifact required to resume staging")
		}
		artifact, err := ReadArtifact(ctx, archive, plan.After.ArchiveSHA256, s.binding.Harness)
		if err != nil {
			return err
		}
		if artifact.Manifest.Digest != plan.After.BundleDigest || artifact.Manifest.Profile != s.binding.Profile {
			return fmt.Errorf("%w: artifact changed", ErrInstallConflict)
		}
		if err := s.save(receipt, "staging"); err != nil {
			return err
		}
		if err := s.checkpoint("journal"); err != nil {
			return err
		}
		if err := s.stage(ctx, plan, artifact); err != nil {
			return err
		}
	} else {
		if _, err := s.verifyGeneration(ctx, plan.After); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Preserve user edits made during staging; no generation is overwritten.
	if _, err := s.verifyGeneration(ctx, head.Current); err != nil {
		return err
	}
	if err := s.save(receipt, "switching"); err != nil {
		return err
	}
	if err := s.writeJSON("head.json", desired); err != nil {
		return err
	}
	if err := s.checkpoint("head"); err != nil {
		return err
	}
	if _, err := s.verifyGeneration(ctx, plan.After); err != nil {
		return err
	}
	if err := s.save(receipt, "applied"); err != nil {
		return err
	}
	return s.checkpoint("receipt")
}
func (s *InstallStore) Verify(ctx context.Context) (InstallVerification, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return InstallVerification{}, err
	}
	defer unlock()
	head, err := s.head()
	if err != nil {
		return InstallVerification{}, err
	}
	if _, err := s.verifyGeneration(ctx, head.Current); err != nil {
		return InstallVerification{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	present := head.Current != nil
	result := InstallVerification{Current: head.Current, Present: Observation{Value: &present, ObservedAt: &now, Reason: "Verified this managed profile's current generation"}, Loaded: Observation{Reason: "No harness registration or session refresh was performed"}}
	result.Path = s.generationPath(head.Current)
	return result, nil
}
