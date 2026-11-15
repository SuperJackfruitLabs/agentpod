package benchworkspace

import (
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var responseTime = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)

func validExecution(e *Execution) bool {
	return e == nil || idPattern.MatchString(e.ID) && oneOf(e.Phase, "starting", "running", "stopped")
}
func validLease(l *LeaseSummary) bool {
	return l == nil || holderPattern.MatchString(l.Holder) && oneOf(l.Mode, "cooperative", "supervised") && (l.Mode == "supervised") == (l.Execution != nil) && validExecution(l.Execution)
}
func validCaps(bytes, inodes uint64) bool { return bytes <= 1<<50 && inodes <= 1<<40 }
func validTime(value string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, value)
	return t, err == nil && !t.IsZero() && len(value) <= 35 && responseTime.MatchString(value)
}
func validArchive(phase string, a *ScalarArchive, scalar bool) bool {
	terminal := oneOf(phase, "archived", "reaping", "reaped")
	if terminal != (a != nil) {
		return false
	}
	if a == nil {
		return true
	}
	start, ok := validTime(a.ArchivedAt)
	if !ok {
		return false
	}
	if a.ReapAfter != "" {
		end, ok := validTime(a.ReapAfter)
		if !ok || end.Before(start) || end.After(start.Add(365*24*time.Hour)) {
			return false
		}
	} else if !scalar {
		return false
	}
	if a.FreezeDigest != "" && !digestPattern.MatchString(a.FreezeDigest) || a.ReapingDigest != "" && !digestPattern.MatchString(a.ReapingDigest) {
		return false
	}
	for _, value := range []string{a.FrozenAt, a.ReapedAt} {
		if value != "" {
			t, ok := validTime(value)
			if !ok || t.Before(start) {
				return false
			}
		}
	}
	if !scalar {
		if !digestPattern.MatchString(a.FreezeDigest) || phase != "archived" && (a.FrozenAt == "" || a.ReapingDigest == "") || (phase == "reaped") != (a.ReapedAt != "") || phase == "archived" && a.ReapingDigest != "" {
			return false
		}
	}
	return true
}
func validVector(vector []Commit, count int, coordinator string) bool {
	if len(vector) != count || count < 1 || count > 32 {
		return false
	}
	found := false
	for i, member := range vector {
		if !namePattern.MatchString(member.Name) || !commitPattern.MatchString(member.Commit) || i > 0 && vector[i-1].Name >= member.Name {
			return false
		}
		found = found || member.Name == coordinator
	}
	return found
}
func validWorkspace(w Workspace) bool {
	if !keyPattern.MatchString(w.Key) || !idPattern.MatchString(w.BenchID) || !oneOf(w.Phase, "materializing", "initializing", "prepared", "ready", "archived", "reaping", "reaped") || w.MemberCount < 1 || w.MemberCount > 32 || !namePattern.MatchString(w.CheckpointRepository) || !validCaps(w.QuotaBytes, w.QuotaInodes) || !validLease(w.Lease) {
		return false
	}
	if w.TransferState != "" && (!oneOf(w.TransferState, "relinquishing", "transferred") || !oneOf(w.Phase, "ready", "archived", "reaping", "reaped") || w.Lease != nil || w.Pending != nil || w.Checkpoint == nil || w.TransferState == "relinquishing" && w.Phase != "ready") {
		return false
	}
	ready := w.Phase == "ready" && w.Lease == nil && w.Pending == nil && w.Archive == nil && w.TransferState == ""
	if w.ReadyForAcquisition != ready {
		return false
	}
	var archive *ScalarArchive
	if a := w.Archive; a != nil {
		archive = &ScalarArchive{ArchivedAt: a.ArchivedAt, ReapAfter: a.ReapAfter, FreezeDigest: a.FreezeDigest, FrozenAt: a.FrozenAt, ReapingDigest: a.ReapingDigest, ReapedAt: a.ReapedAt, Automatic: a.Automatic}
	}
	if !validArchive(w.Phase, archive, false) || archive != nil && (w.Lease != nil || w.Pending != nil) {
		return false
	}
	if oneOf(w.Phase, "ready", "archived", "reaping", "reaped") && w.Checkpoint == nil {
		return false
	}
	if oneOf(w.Phase, "materializing", "initializing", "prepared") && (w.Lease == nil || w.Lease.Holder != "initialization") {
		return false
	}
	cp := w.Checkpoint
	if cp != nil {
		if !idPattern.MatchString(cp.GenerationID) || !digestPattern.MatchString(cp.ManifestSHA256) || !commitPattern.MatchString(cp.Seal) || cp.PreviousSeal != "" && !commitPattern.MatchString(cp.PreviousSeal) || !validVector(cp.Members, w.MemberCount, w.CheckpointRepository) {
			return false
		}
		for _, member := range cp.Members {
			if member.Name == w.CheckpointRepository && len(member.Commit) != len(cp.Seal) {
				return false
			}
		}
	}
	if p := w.Pending; p != nil {
		if !idPattern.MatchString(p.GenerationID) || !digestPattern.MatchString(p.ManifestSHA256) || p.PreviousSeal != "" && !commitPattern.MatchString(p.PreviousSeal) || !validVector(p.Members, w.MemberCount, w.CheckpointRepository) {
			return false
		}
		if cp == nil {
			if p.PreviousSeal != "" {
				return false
			}
		} else {
			if p.PreviousSeal != cp.Seal || p.GenerationID == cp.GenerationID {
				return false
			}
			for i, member := range p.Members {
				if member.Name != cp.Members[i].Name || len(member.Commit) != len(cp.Members[i].Commit) {
					return false
				}
			}
		}
	}
	if r := w.RecoveredFrom; r != nil {
		if r.BenchID == w.BenchID || !idPattern.MatchString(r.BenchID) || !commitPattern.MatchString(r.Seal) || !digestPattern.MatchString(r.ManifestSHA256) {
			return false
		}
	}
	return true
}
func validWorkspaceInventory(w *WorkspaceInventory) bool {
	if w.Kind != "workspace" || !validWorkspace(w.Workspace) || len(w.Members) != w.MemberCount {
		return false
	}
	found := false
	for i, member := range w.Members {
		if !namePattern.MatchString(member.Name) || i > 0 && w.Members[i-1].Name >= member.Name || !shortBranch(member.Branch) || !shortBranch(member.Base) || !oneOf(member.ObjectFormat, "sha1", "sha256") || !commitPattern.MatchString(member.SourceCommit) {
			return false
		}
		width := 40
		if member.ObjectFormat == "sha256" {
			width = 64
		}
		if len(member.SourceCommit) != width {
			return false
		}
		if w.Checkpoint != nil {
			c := w.Checkpoint.Members[i]
			if c.Name != member.Name || len(c.Commit) != width || member.Name == w.CheckpointRepository && len(w.Checkpoint.Seal) != width {
				return false
			}
		}
		if w.Pending != nil {
			c := w.Pending.Members[i]
			if c.Name != member.Name || len(c.Commit) != width {
				return false
			}
		}
		found = found || member.Name == w.CheckpointRepository
	}
	return found
}
func validScalarInventory(s *ScalarInventory) bool {
	return s.Kind == "scalar" && keyPattern.MatchString(s.Key) && shortBranch(s.Branch) && oneOf(s.State, "active", "archived", "reaping", "reaped") && validCaps(s.QuotaBytes, s.QuotaInodes) && validLease(s.Lease) && (s.Checkpoint == "" || commitPattern.MatchString(s.Checkpoint)) && validArchive(s.State, s.Archive, true) && (s.Archive == nil || s.Lease == nil)
}
func inventoryKey(value Inventory) string {
	switch v := value.(type) {
	case *WorkspaceInventory:
		return v.Key
	case *ScalarInventory:
		return v.Key
	}
	return ""
}
func responseMutation(result Result) *Mutation {
	switch r := result.(type) {
	case *Mutation:
		return r
	case *RunOutcome:
		if r != nil {
			return &r.Mutation
		}
	case *SetupOutcome:
		if r != nil {
			return &r.Mutation
		}
	}
	return nil
}
func validResponseResult(response Response, request Request) bool {
	switch r := response.Result.(type) {
	case *Status:
		if !response.OK || len(r.Benches) > 100000 {
			return false
		}
		for i, item := range r.Benches {
			key := inventoryKey(item)
			if i > 0 && inventoryKey(r.Benches[i-1]) >= key {
				return false
			}
			switch v := item.(type) {
			case *WorkspaceInventory:
				if !validWorkspaceInventory(v) {
					return false
				}
			case *ScalarInventory:
				if !validScalarInventory(v) {
					return false
				}
			default:
				return false
			}
		}
		return request.Key == "" || len(r.Benches) == 1 && inventoryKey(r.Benches[0]) == request.Key
	case *HostStatus:
		return response.OK && r.DataFreeBytes <= MaxSafeInteger && r.StateFreeBytes <= MaxSafeInteger
	}
	mutation := responseMutation(response.Result)
	if mutation == nil || !validWorkspace(mutation.Workspace) {
		return false
	}
	w := mutation.Workspace
	op := response.Operation
	if request.Key != "" && w.Key != request.Key {
		return false
	}
	// Fresh acquisitions have no token yet, but their returned lease must still
	// belong to the requested holder before any grant can reach the caller.
	if request.Holder != "" && w.Lease != nil && w.Lease.Holder != request.Holder {
		return false
	}
	if g := mutation.Grant; g != nil {
		if !tokenPattern.MatchString(g.LeaseToken) || request.LeaseToken != "" || w.Lease == nil || w.Archive != nil || w.TransferState != "" {
			return false
		}
		switch op {
		case "create", "recover":
			if response.OK || !oneOf(w.Phase, "materializing", "initializing", "prepared") || w.Lease.Holder != "initialization" {
				return false
			}
		case "lease", "run", "setup":
		case "stop_admin":
			if !response.OK || !w.Lease.StopRequested || w.Lease.Execution != nil && w.Lease.Execution.Phase != "stopped" {
				return false
			}
		default:
			return false
		}
	}
	needsRoot := mutation.Grant != nil || op == "create" || op == "recover"
	if needsRoot != (mutation.RootPath != "") {
		return false
	}
	if root := mutation.RootPath; root != "" {
		if len(root) > 4096 || strings.ContainsRune(root, 0) || !filepath.IsAbs(root) || filepath.Clean(root) != root || strings.Contains(root, "//") {
			return false
		}
	}
	if response.OK && (op == "setup" || op == "run" && (request.Checkpoint == nil || *request.Checkpoint)) && (w.Lease != nil || w.Pending != nil) {
		return false
	}
	if response.OK {
		switch op {
		case "create", "recover":
			if oneOf(w.Phase, "materializing", "initializing", "prepared") {
				return false
			}
		case "release":
			if w.Lease != nil || w.Pending != nil {
				return false
			}
		case "checkpoint":
			if w.Checkpoint == nil || w.Pending != nil {
				return false
			}
		case "archive":
			if w.Archive == nil || w.Archive.FrozenAt == "" {
				return false
			}
		case "stop", "stop_admin":
			if w.Lease != nil && (!w.Lease.StopRequested || w.Lease.Execution != nil && w.Lease.Execution.Phase != "stopped") {
				return false
			}
		}
	}
	var outcome *RunOutcome
	switch r := response.Result.(type) {
	case *RunOutcome:
		outcome = r
	case *SetupOutcome:
		outcome = &r.RunOutcome
		if len(r.Preparation) < 1 || len(r.Preparation) > w.MemberCount {
			return false
		}
		for i, p := range r.Preparation {
			if !namePattern.MatchString(p.Name) || !oneOf(p.Status, "prepared", "failed", "pending") || i > 0 && r.Preparation[i-1].Name >= p.Name || response.OK && p.Status != "prepared" {
				return false
			}
		}
	}
	if outcome != nil {
		if response.OK && outcome.ExitCode != nil && *outcome.ExitCode != 0 {
			return false
		}
		if !validExecution(outcome.Execution) || outcome.Execution != nil && outcome.Execution.Phase != "stopped" || outcome.ExitCode != nil && (outcome.Execution == nil || *outcome.ExitCode < 0 || *outcome.ExitCode > 255) || outcome.LogTruncated != nil && outcome.Execution == nil {
			return false
		}
	}
	return true
}
