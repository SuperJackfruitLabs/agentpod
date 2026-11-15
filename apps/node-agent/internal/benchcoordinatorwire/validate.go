package benchcoordinatorwire

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"regexp"
	"unicode/utf16"
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`)
var shaPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var bidPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var keyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)
var commitPattern = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)

func product(s, p string) bool {
	return len(s) <= 128 && regexp.MustCompile(`^`+p+`_[A-Za-z0-9]{6,}$`).MatchString(s)
}
func one(s string, vs ...string) bool {
	for _, v := range vs {
		if s == v {
			return true
		}
	}
	return false
}
func hashes(ss ...string) bool {
	for _, s := range ss {
		if !shaPattern.MatchString(s) {
			return false
		}
	}
	return true
}
func ids(ss ...string) bool {
	for _, s := range ss {
		if !idPattern.MatchString(s) {
			return false
		}
	}
	return true
}
func validIdentity(i Identity) bool {
	return ids(i.TenantID, i.StageID, i.StationID, i.NodeID, i.AttemptID, i.ControlGrantID) && product(i.BoardID, "brd") && product(i.CardID, "card") && product(i.RunID, "run") && product(i.AgentID, "agt") && product(i.ControlPrincipalID, "prn") && i.Epoch > 0 && i.Epoch <= 9007199254740991 && hashes(i.PolicySHA256)
}
func validTarget(t Target) bool {
	return ids(t.TenantID, t.StationID, t.NodeID, t.HostID) && product(t.BoardID, "brd") && product(t.AgentID, "agt") && hashes(t.RegistrySHA256, t.CoordinatorImplementationSHA256, t.WorkerSHA256) && t.ExecutionMode == "linux-cgroup-v2" && t.BenchProtocol == "superbench.v2" && t.WorkerVersion == "agentpod.superbench-worker.v2"
}
func matched(i Identity, t Target) bool {
	return validIdentity(i) && validTarget(t) && i.TenantID == t.TenantID && i.BoardID == t.BoardID && i.AgentID == t.AgentID && i.StationID == t.StationID && i.NodeID == t.NodeID
}
func validSource(s Source, card string) bool {
	return namePattern.MatchString(s.Name) && hashes(s.RepositorySHA256) && s.TaskRef == "refs/heads/card/"+card && commitPattern.MatchString(s.Commit)
}
func validBinding(b SourceBinding) bool {
	if !validIdentity(b.Identity) || !ids(b.HostID) || !keyPattern.MatchString(b.BenchKey) || !bidPattern.MatchString(b.BenchID) || !hashes(b.RequestSHA256, b.BodySHA256, b.ContextSHA256, b.WorkerSHA256) || len(b.Sources) < 1 || len(b.Sources) > 32 || len(b.Sources) != len(b.Members) || len(b.Sources) != len(b.Checkpoint.Members) || !bidPattern.MatchString(b.Checkpoint.GenerationID) || !hashes(b.Checkpoint.ManifestSHA256) || !commitPattern.MatchString(b.Checkpoint.Seal) || (b.Checkpoint.PreviousSeal != "" && !commitPattern.MatchString(b.Checkpoint.PreviousSeal)) {
		return false
	}
	seen := map[string]bool{}
	for n, s := range b.Sources {
		m := b.Members[n]
		cp := b.Checkpoint.Members[n]
		if !validSource(s, b.Identity.CardID) || (n > 0 && b.Sources[n-1].Name >= s.Name) || seen[s.RepositorySHA256] || m.Name != s.Name || m.RepositorySHA256 != s.RepositorySHA256 || m.TaskRef != s.TaskRef || m.Commit != s.Commit || !one(m.ObjectFormat, "sha1", "sha256") || (m.ObjectFormat == "sha1") != (len(m.Commit) == 40) || cp.Name != s.Name || cp.Commit != s.Commit {
			return false
		}
		seen[s.RepositorySHA256] = true
	}
	steps := []string{"lease", "checkpoint"}
	if len(b.Operations) == 3 {
		steps = []string{"create", "lease", "checkpoint"}
	}
	if len(b.Operations) != len(steps) {
		return false
	}
	for n, o := range b.Operations {
		if o.Step != steps[n] || o.Phase != "observed" || o.HTTPStatus != 200 || !hashes(o.RequestSHA256, o.BodySHA256, o.ResponseSHA256) {
			return false
		}
	}
	return true
}
func BindingDigest(b SourceBinding) (string, error) {
	if !validBinding(b) {
		return "", ErrInvalid
	}
	raw, e := json.Marshal(b)
	if e != nil {
		return "", ErrInvalid
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
func validPrepared(p Prepared) bool {
	if !validBinding(p.Binding) || (!hashes(p.BindingSHA256, p.SourceRequestSHA256) || !keyPattern.MatchString(p.RequestID)) || !namePattern.MatchString(p.CheckpointRepository) {
		return false
	}
	for _, m := range p.Binding.Members {
		if m.Name == p.CheckpointRepository {
			n := 40
			if m.ObjectFormat == "sha256" {
				n = 64
			}
			return len(p.Binding.Checkpoint.Seal) == n && (p.Binding.Checkpoint.PreviousSeal == "" || len(p.Binding.Checkpoint.PreviousSeal) == n)
		}
	}
	return false
}
func validCompletion(c Completion) bool {
	p := c.Source
	b := p.Binding
	s := c.Service
	t := c.Task
	i := b.Identity
	if !hashes(c.SourceRequestSHA256, c.SourceReceiptSHA256) || c.SourceRequestSHA256 != p.SourceRequestSHA256 {
		return false
	}
	if !validPrepared(p) || s.RequestID != p.RequestID || s.RequestSHA256 != b.RequestSHA256 || s.BodySHA256 != b.BodySHA256 || !hashes(s.ResponseSHA256, s.WorkerResultSHA256, s.ManifestSHA256) || !bidPattern.MatchString(s.ExecutionID) || !s.Stopped || !s.Released || s.Kind != "grouped-v2" || !bidPattern.MatchString(s.GenerationID) || !commitPattern.MatchString(s.SealCommit) || len(s.SealCommit) != len(b.Checkpoint.Seal) || len(s.Checkpoints) != len(b.Sources) || t.Version != "agentpod.superbench-worker.v2" || !one(t.Outcome, "complete", "blocked", "failed") || t.Handoff == nil || t.Binding != (WorkerBinding{BoardID: i.BoardID, CardID: i.CardID, RunID: i.RunID, Epoch: i.Epoch}) {
		return false
	}
	for n, m := range s.Checkpoints {
		old := b.Sources[n]
		if !validSource(m, i.CardID) || m.Name != old.Name || m.RepositorySHA256 != old.RepositorySHA256 || m.TaskRef != old.TaskRef || len(m.Commit) != len(old.Commit) {
			return false
		}
	}
	// JS JSON.stringify counts literal Unicode bytes. Go's default HTML escaping
	// is not part of the worker's whole serialized-size constraint.
	size, e := wireSize(t)
	return e == nil && size <= 65536
}
func ParseRequest(raw []byte) (Request, error) { return parseRequest(raw, MaxRequest) }

func parseRequest(raw []byte, limit int) (Request, error) {
	var r Request
	if decode(raw, limit, &r) != nil || r.Version != Version {
		return Request{}, ErrInvalid
	}
	switch r.Operation {
	case "ready":
		if !fields(raw, "version", "operation", "tenant_id", "board_id", "station_id") || !ids(r.TenantID, r.StationID) || !product(r.BoardID, "brd") {
			return Request{}, ErrInvalid
		}
	case "prepare", "execute", "status":
		names := []string{"version", "operation", "identity", "target"}
		if r.Operation == "prepare" {
			names = append(names, "task")
		}
		if r.Operation == "execute" {
			names = append(names, "binding_sha256", "source_receipt")
		}
		if !fields(raw, names...) || r.Identity == nil || r.Target == nil || !matched(*r.Identity, *r.Target) {
			return Request{}, ErrInvalid
		}
		if r.Operation == "prepare" {
			t := r.Task
			if t == nil || !ids(t.ProfileID) || t.Prompt == "" || len(utf16.Encode([]rune(t.Prompt))) > 65536 || t.TimeoutSeconds < 1 || t.TimeoutSeconds > 3600 || (t.RepositoryName != "" && !namePattern.MatchString(t.RepositoryName)) {
				return Request{}, ErrInvalid
			}
		}
		if r.Operation == "execute" {
			p := r.SourceReceipt
			if !hashes(r.BindingSHA256) || p == nil || p.RunID != r.Identity.RunID || p.Epoch != r.Identity.Epoch || !hashes(p.SourceDigest) || p.AdmittedAt > 9007199254740991 {
				return Request{}, ErrInvalid
			}
		}
	default:
		return Request{}, ErrInvalid
	}
	return r, nil
}
func ParseResponse(raw []byte, request Request) (Response, error) {
	requestRaw, requestErr := json.Marshal(request)
	requestSize, sizeErr := wireSize(request)
	if requestErr != nil || sizeErr != nil || requestSize > MaxRequest {
		return Response{}, ErrInvalid
	}
	checked, requestErr := parseRequest(requestRaw, MaxRequest*8)
	if requestErr != nil {
		return Response{}, ErrInvalid
	}
	request = checked
	var r Response
	if decode(raw, MaxResponse, &r) != nil || r.Version != Version || r.Operation != request.Operation {
		return Response{}, ErrInvalid
	}
	names := []string{"version", "operation", "state"}
	if r.State == "refused" {
		if !one(r.Code, "invalid", "unsupported", "unavailable", "unauthorized", "stale_owner", "conflict", "pending", "verification_failed") || !fields(raw, append(names, "code")...) {
			return Response{}, ErrInvalid
		}
		return r, nil
	}
	if r.Operation == "ready" {
		switch r.State {
		case "unavailable":
			if !one(r.Code, "disabled", "unsupported", "offline", "unverified") || !fields(raw, append(names, "code")...) {
				return Response{}, ErrInvalid
			}
		case "available":
			if r.Target == nil || !validTarget(*r.Target) || r.Target.TenantID != request.TenantID || r.Target.BoardID != request.BoardID || r.Target.StationID != request.StationID || !fields(raw, append(names, "target")...) {
				return Response{}, ErrInvalid
			}
		default:
			return Response{}, ErrInvalid
		}
		return r, nil
	}
	if request.Identity == nil || request.Target == nil || r.Identity == nil || r.Target == nil || !matched(*r.Identity, *r.Target) || *r.Identity != *request.Identity || *r.Target != *request.Target {
		return Response{}, ErrInvalid
	}
	names = append(names, "identity", "target")
	var p *Prepared
	switch r.State {
	case "unknown", "pending", "superseded":
	case "prepared":
		if !one(r.Operation, "prepare", "status") || r.Source == nil {
			return Response{}, ErrInvalid
		}
		p = r.Source
		names = append(names, "source")
	case "completed":
		if !one(r.Operation, "execute", "status") || r.Completion == nil || !validCompletion(*r.Completion) {
			return Response{}, ErrInvalid
		}
		p = &r.Completion.Source
		names = append(names, "completion")
	default:
		return Response{}, ErrInvalid
	}
	if !fields(raw, names...) {
		return Response{}, ErrInvalid
	}
	if p != nil {
		h, e := BindingDigest(p.Binding)
		if !validPrepared(*p) || e != nil || h != p.BindingSHA256 || !reflect.DeepEqual(p.Binding.Identity, *r.Identity) || p.Binding.HostID != r.Target.HostID || p.Binding.WorkerSHA256 != r.Target.WorkerSHA256 || (request.Operation == "execute" && request.BindingSHA256 != p.BindingSHA256) {
			return Response{}, ErrInvalid
		}
	}
	return r, nil
}
