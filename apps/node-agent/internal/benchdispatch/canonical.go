package benchdispatch

import (
	"context"
	"path/filepath"
	"strconv"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcanonical"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// CanonicalSource derives the proposed owner's digest of the actual saved RUN
// request inside the binding lock. It exposes no raw request or capability.
func (s Store) CanonicalSource(ctx context.Context, spec SourceSpec) (SourceBinding, benchcanonical.Digests, error) {
	var d benchcanonical.Digests
	if !validSourceSpec(spec) {
		return SourceBinding{}, d, ErrInvalid
	}
	_, b, e := s.readBinding(ctx, spec, &d)
	if e != nil {
		return SourceBinding{}, benchcanonical.Digests{}, e
	}
	return b, d, nil
}

// CompletedCanonical adds owner digests to the same locked, independently
// validated historical completion. They bind content; they do not attest a host.
func (s Store) CompletedCanonical(ctx context.Context, spec SourceSpec) (SourceBinding, Observation, superbench.WorkerResult, benchcanonical.Digests, error) {
	var d benchcanonical.Digests
	b, o, task, e := s.completed(ctx, spec, &d)
	if e != nil {
		return SourceBinding{}, Observation{}, superbench.WorkerResult{}, benchcanonical.Digests{}, e
	}
	return b, o, task, d, nil
}

// canonicalRun is called only while the journal holds its existing flock. Actual
// request/raw-response hashes keep their original meanings and remain checked.
func (s Store) canonicalRun(spec SourceSpec, p Plan, observed *Observation) (benchcanonical.Digests, error) {
	var d benchcanonical.Digests
	request, raw, e := s.boundRun(p, spec)
	if e != nil {
		return d, e
	}
	d.SourceRequestSHA256, e = benchcanonical.Digest(raw)
	if e != nil {
		return benchcanonical.Digests{}, ErrVerify
	}
	if observed == nil {
		return d, nil
	}
	record, e := readFile(filepath.Join(s.Root, sourceFile(spec, "run", ".response")), benchworkspace.MaxResponse+4, true)
	if e != nil || len(record) < 4 || record[3] != '\n' || digest(record[4:]) != observed.ResponseSHA256 {
		return benchcanonical.Digests{}, ErrVerify
	}
	status, e := strconv.Atoi(string(record[:3]))
	if e != nil {
		return benchcanonical.Digests{}, ErrVerify
	}
	reply, e := benchworkspace.ParseResponse(record[4:], status, request)
	if e != nil || !reply.OK {
		return benchcanonical.Digests{}, ErrVerify
	}
	d.SourceReceiptSHA256, e = benchcanonical.ReceiptDigest(record[4:])
	if e != nil {
		return benchcanonical.Digests{}, ErrVerify
	}
	return d, nil
}
