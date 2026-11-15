package benchattempt

import (
	"regexp"
	"strings"
)

const IDPattern = `^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`
const SHA256Pattern = `^[a-f0-9]{64}$`
const CommitPattern = `^([a-f0-9]{40}|[a-f0-9]{64})$`

var modelID = regexp.MustCompile(IDPattern)
var modelSHA = regexp.MustCompile(SHA256Pattern)
var modelCommit = regexp.MustCompile(CommitPattern)

func ValidSources(v []Source) bool {
	if len(v) == 0 || len(v) > 32 {
		return false
	}
	names := map[string]bool{}
	targets := map[string]bool{}
	for i, s := range v {
		if !modelID.MatchString(s.Name) || names[s.Name] || (i > 0 && v[i-1].Name >= s.Name) || !modelSHA.MatchString(s.RepositorySHA256) || !modelCommit.MatchString(s.Commit) || !ValidRef(s.TaskRef) {
			return false
		}
		target := s.RepositorySHA256 + "\x00" + s.TaskRef
		if targets[target] {
			return false
		}
		targets[target] = true
		names[s.Name] = true
	}
	return true
}
func ValidRef(s string) bool {
	if len(s) > 4096 || !strings.HasPrefix(s, "refs/heads/") || strings.ContainsAny(s, " ~^:?*[\\\x7f") || strings.Contains(s, "..") || strings.Contains(s, "@{") || strings.HasSuffix(s, ".") {
		return false
	}
	for _, r := range s {
		if r < 32 {
			return false
		}
	}
	for _, c := range strings.Split(s, "/") {
		if c == "" || strings.HasPrefix(c, ".") || strings.HasSuffix(c, ".lock") {
			return false
		}
	}
	return true
}
func ValidateObservation(p Plan, o Observation) error {
	if o.RequestID != p.RequestID || o.RequestSHA256 != p.RequestSHA256 || o.BodySHA256 != p.BodySHA256 || !modelID.MatchString(o.ExecutionID) || !o.Stopped || !o.Released || !modelSHA.MatchString(o.ResponseSHA256) || !modelSHA.MatchString(o.WorkerResultSHA256) || !ValidSources(o.Checkpoints) || len(o.Checkpoints) != len(p.Sources) {
		return ErrVerify
	}
	for i, s := range p.Sources {
		c := o.Checkpoints[i]
		if s.Name != c.Name || s.RepositorySHA256 != c.RepositorySHA256 || s.TaskRef != c.TaskRef {
			return ErrVerify
		}
	}
	switch o.Kind {
	case "scalar-v1":
		if p.Grouped != nil {
			return ErrVerify
		}
		if len(o.Checkpoints) != 1 || o.GenerationID != "" || o.SealCommit != "" || o.ManifestSHA256 != "" {
			return ErrVerify
		}
	case "grouped-v2":
		if p.Grouped == nil {
			return ErrVerify
		}
		if len(o.GenerationID) != 32 || !modelSHA.MatchString(o.GenerationID+o.GenerationID) || !modelCommit.MatchString(o.SealCommit) || !modelSHA.MatchString(o.ManifestSHA256) {
			return ErrVerify
		}
	default:
		return ErrVerify
	}
	return nil
}

var modelGroupedBindingID = regexp.MustCompile(`^(brd|card|run)_[A-Za-z0-9]{6,}$`)

// Match the packaged grouped worker's binding grammar before any growth.
func ValidGroupedIdentity(identity Identity) bool {
	for i, id := range []string{identity.BoardID, identity.CardID, identity.RunID} {
		if !modelGroupedBindingID.MatchString(id) || !strings.HasPrefix(id, []string{"brd_", "card_", "run_"}[i]) {
			return false
		}
	}
	return true
}

func SourceSteps(s SourceSpec) []string {
	if s.Create {
		return []string{"create", "lease", "checkpoint"}
	}
	return []string{"lease", "checkpoint"}
}
