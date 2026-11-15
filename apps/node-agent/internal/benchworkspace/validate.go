package benchworkspace

import (
	"encoding/json"
	"regexp"
	"strings"
)

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)
var holderPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$`)
var tokenPattern = regexp.MustCompile(`^([a-f0-9]{32}|[a-f0-9]{48})$`)
var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var commitPattern = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func fieldSet(raw []byte, required, optional []string) (map[string]json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, false
	}
	allowed := map[string]bool{}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return nil, false
		}
		allowed[key] = true
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key := range fields {
		if !allowed[key] {
			return nil, false
		}
	}
	return fields, true
}

func validRequest(r Request, fields map[string]json.RawMessage) bool {
	for _, item := range []struct {
		field, value string
		pattern      *regexp.Regexp
	}{
		{"key", r.Key, keyPattern}, {"request_id", r.RequestID, keyPattern}, {"holder", r.Holder, holderPattern},
		{"lease_token", r.LeaseToken, tokenPattern}, {"repository_name", r.RepositoryName, namePattern},
		{"checkpoint_repository", r.CheckpointRepository, namePattern},
	} {
		if _, present := fields[item.field]; present && !item.pattern.MatchString(item.value) {
			return false
		}
	}
	if r.Initialize != nil && !*r.Initialize {
		return false
	}
	if _, present := fields["arguments"]; present {
		if len(r.Arguments) < 1 || len(r.Arguments) > 128 || r.Arguments[0] == "" {
			return false
		}
		for _, argument := range r.Arguments {
			if len(argument) > 8192 {
				return false
			}
		}
	}
	if _, present := fields["repositories"]; present && !validMembers(r, fields["repositories"]) {
		return false
	}
	if r.Operation == "recover" {
		if _, ok := fieldSet(fields["source"], []string{"repository", "bench_id", "commit", "manifest_sha256"}, nil); !ok || r.Source == nil {
			return false
		}
		s := r.Source
		if !validRepository(s.Repository) || !idPattern.MatchString(s.BenchID) || !commitPattern.MatchString(s.Commit) || !digestPattern.MatchString(s.ManifestSHA256) {
			return false
		}
		found := false
		for _, member := range r.Repositories {
			found = found || member.Repository == s.Repository
		}
		if !found {
			return false
		}
	}
	return true
}

func validMembers(r Request, raw []byte) bool {
	if len(r.Repositories) < 1 || len(r.Repositories) > 32 {
		return false
	}
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || len(entries) != len(r.Repositories) {
		return false
	}
	optional := []string{"branch"}
	if r.Operation == "create" {
		optional = append(optional, "base")
	}
	coordinator := false
	targets := map[[2]string]bool{}
	for i, member := range r.Repositories {
		fields, ok := fieldSet(entries[i], []string{"name", "repository"}, optional)
		if !ok || !namePattern.MatchString(member.Name) || i > 0 && r.Repositories[i-1].Name >= member.Name || !validRepository(member.Repository) {
			return false
		}
		for _, item := range []struct{ field, value string }{{"branch", member.Branch}, {"base", member.Base}} {
			if _, present := fields[item.field]; present && !shortBranch(item.value) {
				return false
			}
		}
		branch := member.Branch
		if branch == "" {
			branch = "bench/" + r.Key
		}
		target := [2]string{member.Repository, branch}
		if targets[target] {
			return false
		}
		targets[target] = true
		coordinator = coordinator || member.Name == r.CheckpointRepository
	}
	return r.Operation != "create" || coordinator
}

func shortBranch(branch string) bool {
	return len(branch) > 0 && len(branch) <= 255 && branch != "@" && branch != "HEAD" && !strings.HasPrefix(branch, "-") && !strings.HasPrefix(branch, "refs/") && validBranchRef("refs/heads/"+branch)
}
