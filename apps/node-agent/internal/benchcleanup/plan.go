// Package benchcleanup owns opaque, private original-operation cleanup targets.
// A plan is data, not authorization; the journal must revalidate it before use.
package benchcleanup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

type Plan struct {
	targets []benchworkspace.CancelRequest
	owner   *benchworkspace.Request
}

// New accepts only exact original growth identities and an optional private
// owner-token stop. Neither a key-only stop nor an administrative stop is valid.
func New(targets []benchworkspace.CancelRequest, owner *benchworkspace.Request) (*Plan, error) {
	if len(targets) > 3 {
		return nil, benchattempt.ErrInvalid
	}
	p := &Plan{targets: append([]benchworkspace.CancelRequest(nil), targets...)}
	seen := map[string]bool{}
	for _, target := range targets {
		raw, e := json.Marshal(target)
		if e != nil {
			return nil, benchattempt.ErrInvalid
		}
		if _, e = benchworkspace.ParseCancelRequest(raw); e != nil || seen[target.TargetRequestID] {
			return nil, benchattempt.ErrInvalid
		}
		seen[target.TargetRequestID] = true
	}
	if owner != nil {
		raw, e := json.Marshal(owner)
		if e != nil {
			return nil, benchattempt.ErrInvalid
		}
		parsed, e := benchworkspace.Parse(raw)
		if e != nil || parsed.Operation != "stop" || parsed.LeaseToken == "" || parsed.RequestID != "" {
			return nil, benchattempt.ErrInvalid
		}
		p.owner = &parsed
	}
	return p, nil
}

// Digest identifies this private snapshot, including the original random token.
// It neither grants ownership nor permits reconstructing the private request.
func (p *Plan) Digest() string {
	if p == nil {
		return ""
	}
	raw, _ := json.Marshal(struct {
		Targets []benchworkspace.CancelRequest
		Owner   *benchworkspace.Request
	}{p.targets, p.owner})
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}

// Use explicitly exposes copies only to private transport orchestration.
func (p *Plan) Use(fn func([]benchworkspace.CancelRequest, *benchworkspace.Request) error) error {
	if p == nil || fn == nil {
		return benchattempt.ErrInvalid
	}
	var owner *benchworkspace.Request
	if p.owner != nil {
		copy := *p.owner
		owner = &copy
	}
	return fn(append([]benchworkspace.CancelRequest(nil), p.targets...), owner)
}
func (Plan) MarshalJSON() ([]byte, error) { return nil, benchattempt.ErrInvalid }
func (*Plan) UnmarshalJSON([]byte) error  { return benchattempt.ErrInvalid }
func (Plan) String() string               { return "[private original-operation cleanup]" }
func (p Plan) Format(s fmt.State, _ rune) { _, _ = io.WriteString(s, p.String()) }

// Accepts binds an observation to an exact private original transport target.
func (p *Plan) Accepts(o benchattempt.CleanupObservation) bool {
	if p == nil || !benchattempt.ValidCleanupObservation(o) {
		return false
	}
	for _, t := range p.targets {
		if o.Operation == "cancel" && t.TargetRequestID == o.TargetRequestID && t.TargetDigest == o.TargetDigest {
			return true
		}
	}
	if p.owner != nil {
		d, _ := p.owner.Digest()
		return o.Operation == "stop" && d == o.TargetDigest
	}
	return false
}
