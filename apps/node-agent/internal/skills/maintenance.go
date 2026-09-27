package skills

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

// RetentionFloor is deliberately small but non-zero.  It retains a readable
// completed history even when none of those receipts is needed by either head.
const RetentionFloor = 32

// MaintenancePreview is the node-owned, read-only input to a later reviewed
// cleanup operation.  Paths are relative to the private namespace, never
// supplied by a caller.
type MaintenancePreview struct {
	Generations      []string `json:"generations"`
	Operations       []string `json:"operations"`
	NativeOperations []string `json:"nativeOperations"`
	NativeBackups    []string `json:"nativeBackups"`
}

// MaintenancePlan is a read-only, reviewable maintenance proposal.  The digest
// binds exactly the candidates returned by this node; it is not an authority to
// remove arbitrary caller-selected paths.
type MaintenancePlan struct {
	Preview    MaintenancePreview `json:"preview"`
	PlanDigest string             `json:"planDigest"`
	ObservedAt string             `json:"observedAt"`
	Limitation string             `json:"limitation"`
}
type maintenanceEntry struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type maintenanceJournal struct {
	Plan    MaintenancePlan    `json:"plan"`
	Pending []maintenanceEntry `json:"pending"`
}

func (p MaintenancePreview) Empty() bool {
	return len(p.Generations)+len(p.Operations)+len(p.NativeOperations)+len(p.NativeBackups) == 0
}

func maintenanceEntries(root *os.Root, name string, limit int) ([]os.DirEntry, error) {
	directory, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	entries, err := directory.ReadDir(limit + 1)
	closeErr := directory.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if len(entries) > limit {
		return nil, fmt.Errorf("%w: retained %s exceeds its limit", ErrInstallConflict, name)
	}
	return entries, nil
}

func optionalMaintenanceEntries(root *os.Root, name string, limit int) ([]os.DirEntry, error) {
	entries, err := maintenanceEntries(root, name, limit)
	if errors.Is(err, os.ErrNotExist) {
		return []os.DirEntry{}, nil
	}
	return entries, err
}

func generationReferences(head installHead) map[string]bool {
	refs := map[string]bool{}
	for _, generation := range []*Generation{head.Current, head.Previous} {
		if generation != nil {
			refs[generation.Generation] = true
		}
	}
	return refs
}

// MaintenancePreview verifies every retained receipt before proposing anything.
// An incomplete, conflicting, malformed, or actively publishing namespace is
// an ambiguity, not an invitation to delete recovery evidence.
func (s *InstallStore) MaintenancePreview(ctx context.Context) (MaintenancePreview, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return MaintenancePreview{}, err
	}
	defer unlock()
	return s.maintenancePreviewLocked(ctx)
}

func (s *InstallStore) maintenancePreviewLocked(ctx context.Context) (MaintenancePreview, error) {
	if err := ctx.Err(); err != nil {
		return MaintenancePreview{}, err
	}
	managed, err := s.head()
	if err != nil {
		return MaintenancePreview{}, err
	}
	native, err := s.placementHead()
	if err != nil {
		return MaintenancePreview{}, err
	}
	if active, err := s.activePlacement(); err != nil || active != "" {
		if err != nil {
			return MaintenancePreview{}, err
		}
		return MaintenancePreview{}, fmt.Errorf("%w: native publication requires recovery", ErrInstallConflict)
	}
	refs := generationReferences(managed)
	for id := range generationReferences(native) {
		refs[id] = true
	}
	preview := MaintenancePreview{}
	managedCandidates, err := s.completedMaintenanceOperations("operations", false, managed.OperationID, RetentionFloor)
	if err != nil {
		return preview, err
	}
	preview.Operations = managedCandidates
	nativeCandidates, err := s.completedOptionalMaintenanceOperations("native/operations", true, native.OperationID, RetentionFloor)
	if err != nil {
		return preview, err
	}
	preview.NativeOperations = nativeCandidates
	candidateNative := map[string]bool{}
	for _, id := range nativeCandidates {
		candidateNative[id] = true
	}
	entries, err := maintenanceEntries(s.root, "generations", 256)
	if err != nil {
		return preview, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !operationPattern.MatchString(name) || entry.Type()&os.ModeSymlink != 0 {
			return preview, fmt.Errorf("%w: invalid retained generation", ErrInstallConflict)
		}
		info, err := s.root.Lstat(path.Join("generations", name))
		if err != nil || !info.IsDir() {
			if err != nil {
				return preview, err
			}
			return preview, fmt.Errorf("%w: invalid retained generation", ErrInstallConflict)
		}
		if !refs[name] {
			preview.Generations = append(preview.Generations, name)
		}
	}
	backups, err := optionalMaintenanceEntries(s.root, "native/backups", 256)
	if err != nil {
		return preview, err
	}
	for _, entry := range backups {
		name := entry.Name()
		if !operationPattern.MatchString(name) || entry.Type()&os.ModeSymlink != 0 || !candidateNative[name] {
			return preview, fmt.Errorf("%w: retained native backup is not safely removable", ErrInstallConflict)
		}
		info, err := s.root.Lstat(path.Join("native/backups", name))
		if err != nil || !info.IsDir() {
			if err != nil {
				return preview, err
			}
			return preview, fmt.Errorf("%w: invalid retained native backup", ErrInstallConflict)
		}
		preview.NativeBackups = append(preview.NativeBackups, name)
	}
	sort.Strings(preview.Generations)
	sort.Strings(preview.Operations)
	sort.Strings(preview.NativeOperations)
	sort.Strings(preview.NativeBackups)
	return preview, nil
}

func (s *InstallStore) PlanMaintenance(ctx context.Context) (MaintenancePlan, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return MaintenancePlan{}, err
	}
	defer unlock()
	if _, err := s.root.Lstat("maintenance.json"); err == nil {
		return MaintenancePlan{}, fmt.Errorf("%w: maintenance requires recovery", ErrInstallConflict)
	} else if !errors.Is(err, os.ErrNotExist) {
		return MaintenancePlan{}, err
	}
	preview, err := s.maintenancePreviewLocked(ctx)
	if err != nil {
		return MaintenancePlan{}, err
	}
	return MaintenancePlan{
		Preview: preview, PlanDigest: hashJSON(preview), ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Limitation: "Apply requires this exact reviewed digest. A durable node journal records and resumes only these candidates.",
	}, nil
}

func maintenanceEntriesFor(plan MaintenancePlan) []maintenanceEntry {
	entries := []maintenanceEntry{}
	for _, pair := range []struct {
		kind string
		ids  []string
	}{{"generations", plan.Preview.Generations}, {"operations", plan.Preview.Operations}, {"native/operations", plan.Preview.NativeOperations}, {"native/backups", plan.Preview.NativeBackups}} {
		for _, id := range pair.ids {
			entries = append(entries, maintenanceEntry{pair.kind, id})
		}
	}
	return entries
}

// ApplyMaintenance never accepts paths. It removes only entries persisted in
// the reviewed journal; interruption leaves the remaining exact set to resume.
func (s *InstallStore) ApplyMaintenance(ctx context.Context, digest string) (MaintenancePlan, error) {
	unlock, err := s.lock(ctx)
	if err != nil {
		return MaintenancePlan{}, err
	}
	defer unlock()
	var journal maintenanceJournal
	if err = s.readJSON("maintenance.json", &journal); errors.Is(err, os.ErrNotExist) {
		preview, planErr := s.maintenancePreviewLocked(ctx)
		if planErr != nil {
			return MaintenancePlan{}, planErr
		}
		plan := MaintenancePlan{Preview: preview, PlanDigest: hashJSON(preview), ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Limitation: "Apply requires this exact reviewed digest. A durable node journal records and resumes only these candidates."}
		if plan.PlanDigest != digest {
			return MaintenancePlan{}, fmt.Errorf("%w: reviewed maintenance digest differs", ErrInstallConflict)
		}
		journal = maintenanceJournal{Plan: plan, Pending: maintenanceEntriesFor(plan)}
		if err = s.writeJSON("maintenance.json", journal); err != nil {
			return MaintenancePlan{}, err
		}
	} else if err != nil {
		return MaintenancePlan{}, err
	} else if journal.Plan.PlanDigest != digest {
		return MaintenancePlan{}, fmt.Errorf("%w: maintenance recovery belongs to another review", ErrInstallConflict)
	}
	for len(journal.Pending) > 0 {
		entry := journal.Pending[0]
		if !operationPattern.MatchString(entry.ID) {
			return MaintenancePlan{}, fmt.Errorf("%w: invalid maintenance journal", ErrInstallConflict)
		}
		relative := path.Join(entry.Kind, entry.ID)
		if entry.Kind == "operations" || entry.Kind == "native/operations" {
			relative += ".json"
		}
		if err = s.root.RemoveAll(relative); err != nil {
			return MaintenancePlan{}, err
		}
		journal.Pending = journal.Pending[1:]
		if err = s.writeJSON("maintenance.json", journal); err != nil {
			return MaintenancePlan{}, err
		}
		if err = s.checkpoint("maintenance-remove"); err != nil {
			return MaintenancePlan{}, err
		}
	}
	if err = s.root.Remove("maintenance.json"); err != nil {
		return MaintenancePlan{}, err
	}
	return journal.Plan, syncDir(s.root, ".")
}

func (s *InstallStore) completedOptionalMaintenanceOperations(directory string, native bool, protected string, floor int) ([]string, error) {
	if _, err := s.root.Lstat(directory); errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	} else if err != nil {
		return nil, err
	}
	return s.completedMaintenanceOperations(directory, native, protected, floor)
}

func (s *InstallStore) completedMaintenanceOperations(directory string, native bool, protected string, floor int) ([]string, error) {
	entries, err := maintenanceEntries(s.root, directory, 256)
	if err != nil {
		return nil, err
	}
	type completed struct{ id, at string }
	done := []completed{}
	for _, entry := range entries {
		id := entry.Name()
		if !operationPattern.MatchString(strings.TrimSuffix(id, ".json")) || path.Ext(id) != ".json" || entry.Type()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("%w: invalid retained operation", ErrInstallConflict)
		}
		id = strings.TrimSuffix(id, ".json")
		if native {
			receipt, err := s.placementOperation(id)
			if err != nil {
				return nil, err
			}
			if receipt.Phase != "applied" || receipt.CompletedAt == nil {
				return nil, fmt.Errorf("%w: native operation requires recovery", ErrInstallConflict)
			}
			done = append(done, completed{id, *receipt.CompletedAt})
		} else {
			receipt, err := s.operation(id)
			if err != nil {
				return nil, err
			}
			if receipt.Phase != "applied" || receipt.CompletedAt == nil {
				return nil, fmt.Errorf("%w: managed operation requires recovery", ErrInstallConflict)
			}
			done = append(done, completed{id, *receipt.CompletedAt})
		}
	}
	sort.Slice(done, func(i, j int) bool { return done[i].at > done[j].at })
	if len(done) <= floor {
		return []string{}, nil
	}
	result := []string{}
	for _, item := range done[floor:] {
		if item.id != protected {
			result = append(result, item.id)
		}
	}
	return result, nil
}
