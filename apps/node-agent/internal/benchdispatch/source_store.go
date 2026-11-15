package benchdispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// SourceGate is the current trusted registry/control-pair check, not proof of
// source effects. No public dispatcher supplies it or enables this private path.
type SourceGate func(context.Context, SourceSpec) error

const privateSourceRequestHeader = "agentpod.private-source-request.v1\n"

func (s Store) ReserveSource(ctx context.Context, spec SourceSpec, gate SourceGate) error {
	if !validSourceSpec(spec) || gate == nil {
		return ErrInvalid
	}
	return s.withDocument(ctx, spec.BenchKey, true, func(doc *state) (bool, error) {
		if cancelled(doc, sourceID(spec)) {
			return false, ErrOwner
		}
		if gate(ctx, spec) != nil || ctx.Err() != nil {
			return false, ErrOwner
		}
		if doc.Source != nil {
			if sourceDigest(doc.Source.Spec) != sourceDigest(spec) {
				return false, ErrPending
			}
			return false, nil
		}
		for _, r := range doc.Records {
			ids := []string{r.Plan.RequestID}
			if r.Source != nil {
				ids = append(ids, r.Source.Spec.LeaseRequestID, r.Source.Spec.RunRequestID)
				if r.Source.Spec.Create {
					ids = append(ids, r.Source.Spec.CreateRequestID)
				}
			}
			for _, used := range ids {
				if used == spec.LeaseRequestID || used == spec.RunRequestID || spec.Create && used == spec.CreateRequestID {
					return false, ErrConflict
				}
			}
			if r.Plan.Identity.RunID == spec.Identity.RunID && r.Plan.Identity.Epoch == spec.Identity.Epoch || r.Plan.RequestID == spec.RunRequestID {
				return false, ErrConflict
			}
		}
		if doc.Active != "" {
			return false, ErrPending
		}
		if len(doc.Records) >= maxRecords {
			return false, ErrInvalid
		}
		if doc.Version != cancellationVersion {
			doc.Version = sourceVersion
		}
		doc.Source = &SourceReservation{Spec: spec, Operations: []SourceOperation{}}
		doc.Active = sourceID(spec)
		return true, nil
	})
}
func (s Store) withSource(ctx context.Context, spec SourceSpec, fn func(*state, *SourceReservation) (bool, error)) error {
	if !validSourceSpec(spec) {
		return ErrInvalid
	}
	return s.withDocument(ctx, spec.BenchKey, false, func(doc *state) (bool, error) {
		if doc.Source == nil || sourceDigest(doc.Source.Spec) != sourceDigest(spec) || doc.Active != sourceID(spec) {
			return false, ErrOwner
		}
		return fn(doc, doc.Source)
	})
}
func sourceFile(spec SourceSpec, step, suffix string) string {
	return digest([]byte(spec.BenchKey)) + "-" + sourceID(spec) + "-" + step + suffix
}
func (s Store) sourceRequest(spec SourceSpec, step string) (benchworkspace.Request, []byte, error) {
	raw, err := readFile(filepath.Join(s.Root, sourceFile(spec, step, ".request")), benchworkspace.MaxBody+len(privateSourceRequestHeader), true)
	if err != nil {
		return benchworkspace.Request{}, nil, ErrPending
	}
	if !bytes.HasPrefix(raw, []byte(privateSourceRequestHeader)) {
		return benchworkspace.Request{}, nil, ErrInvalid
	}
	raw = raw[len(privateSourceRequestHeader):]
	r, err := benchworkspace.Parse(raw)
	if err != nil || !sourceRequestMatches(spec, step, r) {
		return benchworkspace.Request{}, nil, ErrInvalid
	}
	return r, raw, nil
}
func (s Store) sourceReply(spec SourceSpec, step string) (*benchworkspace.Response, error) {
	r, _, err := s.sourceRequest(spec, step)
	if err != nil {
		return nil, err
	}
	raw, err := readFile(filepath.Join(s.Root, sourceFile(spec, step, ".response")), benchworkspace.MaxResponse+4, true)
	if err != nil {
		return nil, ErrPending
	}
	if len(raw) < 4 || raw[3] != '\n' {
		return nil, ErrInvalid
	}
	status, err := strconv.Atoi(string(raw[:3]))
	if err != nil {
		return nil, ErrInvalid
	}
	response, err := benchworkspace.ParseResponse(raw[4:], status, r)
	if err != nil {
		return nil, ErrInvalid
	}
	return &response, nil
}
func (s Store) writeSourceFile(name string, raw []byte) error {
	old, err := readFile(filepath.Join(s.Root, name), benchworkspace.MaxResponse+4, true)
	if err == nil {
		if !bytes.Equal(old, raw) {
			return ErrConflict
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return ErrInvalid
	}
	return writeAtomic(s.Root, name, raw)
}

// BeginSourceOperation persists exact private request bytes and consumes this
// operation's one send opportunity before any transport effect. False means the
// original operation must be reconciled from preserved evidence, never resent.
func (s Store) BeginSourceOperation(ctx context.Context, spec SourceSpec, step string, request benchworkspace.Request, gate SourceGate) (bool, error) {
	if gate == nil || !sourceRequestMatches(spec, step, request) {
		return false, ErrInvalid
	}
	raw, err := json.Marshal(request)
	if err != nil {
		return false, ErrInvalid
	}
	if _, err = benchworkspace.Parse(raw); err != nil {
		return false, ErrInvalid
	}
	body, err := request.Digest()
	if err != nil {
		return false, ErrInvalid
	}
	send := false
	err = s.withSource(ctx, spec, func(doc *state, r *SourceReservation) (bool, error) {
		if cancelled(doc, sourceID(spec)) {
			return false, ErrOwner
		}
		if gate(ctx, spec) != nil || ctx.Err() != nil {
			return false, ErrOwner
		}
		for _, op := range r.Operations {
			if op.Step == step {
				if op.RequestSHA256 != digest(raw) || op.BodySHA256 != body {
					return false, ErrConflict
				}
				return false, nil
			}
		}
		steps := sourceSteps(spec)
		i := len(r.Operations)
		if i >= len(steps) || steps[i] != step || i > 0 && r.Operations[i-1].Phase != "observed" {
			return false, ErrPending
		}
		if step == "checkpoint" {
			reply, e := s.observedSourceReply(spec, r.Operations[len(r.Operations)-1])
			if e != nil {
				return false, e
			}
			m, ok := reply.Result.(*benchworkspace.Mutation)
			if !ok || m.Grant == nil || m.Grant.LeaseToken != request.LeaseToken {
				return false, ErrOwner
			}
		}
		if e := s.writeSourceFile(sourceFile(spec, step, ".request"), append([]byte(privateSourceRequestHeader), raw...)); e != nil {
			return false, e
		}
		r.Operations = append(r.Operations, SourceOperation{Step: step, RequestSHA256: digest(raw), BodySHA256: body, Phase: "pending"})
		send = true
		return true, nil
	})
	return send && err == nil, err
}

// ObserveSourceOperation captures actual bytes privately before advancing the
// journal. Invalid/lost responses leave pending; preserved complete replies can
// be reconciled after a process crash without another network request.
func (s Store) ObserveSourceOperation(ctx context.Context, spec SourceSpec, step string, evidence *benchworkspace.ExchangeEvidence) error {
	return s.withSource(ctx, spec, func(_ *state, r *SourceReservation) (bool, error) {
		if len(r.Operations) == 0 {
			return false, ErrPending
		}
		op := &r.Operations[len(r.Operations)-1]
		if op.Step != step {
			return false, ErrConflict
		}
		request, rawRequest, e := s.sourceRequest(spec, step)
		if e != nil || digest(rawRequest) != op.RequestSHA256 {
			return false, ErrInvalid
		}
		body, e := request.Digest()
		if e != nil || body != op.BodySHA256 {
			return false, ErrInvalid
		}
		if evidence != nil {
			e := evidence.Use(func(status int, request, response []byte) error {
				if digest(request) != op.RequestSHA256 || len(response) == 0 || status < 100 || status > 599 {
					return ErrInvalid
				}
				sent, old, e := s.sourceRequest(spec, step)
				if e != nil || !bytes.Equal(old, request) {
					return ErrInvalid
				}
				if _, e = benchworkspace.ParseResponse(response, status, sent); e != nil {
					return ErrInvalid
				}
				return s.writeSourceFile(sourceFile(spec, step, ".response"), append([]byte(strconv.Itoa(status)+"\n"), response...))
			})
			if e != nil {
				return false, ErrPending
			}
		}
		reply, e := s.sourceReply(spec, step)
		if e != nil {
			return false, e
		}
		raw, e := readFile(filepath.Join(s.Root, sourceFile(spec, step, ".response")), benchworkspace.MaxResponse+4, true)
		if e != nil {
			return false, ErrPending
		}
		status, _ := strconv.Atoi(string(raw[:3]))
		hash := digest(raw[4:])
		phase := "observed"
		if !reply.OK {
			phase = "failed"
		}
		if op.Phase != "pending" {
			if op.Phase != phase || op.HTTPStatus != status || op.ResponseSHA256 != hash {
				return false, ErrConflict
			}
			return false, nil
		}
		op.Phase = phase
		op.HTTPStatus = status
		op.ResponseSHA256 = hash
		return true, nil
	})
}

// SourceReply exposes a private, independently re-parsed historical response to
// this active reservation only. It is never a renewed ownership grant.
func (s Store) SourceReply(ctx context.Context, spec SourceSpec, step string) (*benchworkspace.Response, error) {
	var reply *benchworkspace.Response
	err := s.withSource(ctx, spec, func(_ *state, r *SourceReservation) (bool, error) {
		for _, op := range r.Operations {
			if op.Step == step && (op.Phase == "observed" || op.Phase == "failed") {
				var e error
				reply, e = s.observedSourceReply(spec, op)
				return false, e
			}
		}
		return false, ErrPending
	})
	return reply, err
}

func (s Store) observedSourceReply(spec SourceSpec, op SourceOperation) (*benchworkspace.Response, error) {
	request, raw, e := s.sourceRequest(spec, op.Step)
	if e != nil || digest(raw) != op.RequestSHA256 {
		return nil, ErrInvalid
	}
	body, e := request.Digest()
	if e != nil || body != op.BodySHA256 {
		return nil, ErrInvalid
	}
	response, e := readFile(filepath.Join(s.Root, sourceFile(spec, op.Step, ".response")), benchworkspace.MaxResponse+4, true)
	if e != nil || len(response) < 4 || digest(response[4:]) != op.ResponseSHA256 {
		return nil, ErrInvalid
	}
	status, e := strconv.Atoi(string(response[:3]))
	if e != nil || status != op.HTTPStatus {
		return nil, ErrInvalid
	}
	return s.sourceReply(spec, op.Step)
}
