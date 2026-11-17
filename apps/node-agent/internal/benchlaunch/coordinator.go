// Package benchlaunch is the PROPOSED registered launch for the dedicated bench
// coordinator: the worker's task reaches the payload only as finite stdin bytes
// and its result returns only as sealed stdout. See docs/BENCH_REGISTERED_LAUNCH.md.
// Nothing here is reachable unless an installed registry profile opts in.
package benchlaunch

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// Mode is the registry profile value that selects this launch.
const Mode = "registered-v1"

// Producer is the one SuperBench seam. *benchworkspace.Client implements it:
// each call sends once and returns the complete bounded reply, or ErrLost.
type Producer interface {
	Post(ctx context.Context, path, contentType string, raw []byte, limit int) (int, []byte, error)
}

// Refusal is a terminal decision for the attempt, with a coordinator wire code.
type Refusal struct{ Code string }

func (r *Refusal) Error() string { return "registered launch refused: " + r.Code }
func refuse(code string) error   { return &Refusal{Code: code} }

// RefusalCode reports the wire code of a terminal refusal, if err is one.
func RefusalCode(err error) (string, bool) {
	var r *Refusal
	if errors.As(err, &r) {
		return r.Code, true
	}
	return "", false
}

type Coordinator struct {
	Journal      Journal
	Producer     Producer
	Repositories []benchworkspace.Repository
	// Current is the hub's fresh decision for this exact attempt. It is checked
	// before every send and after every await; it is never cached.
	Current benchdispatch.SourceGate
}

func (c Coordinator) current(ctx context.Context, spec benchdispatch.SourceSpec) error {
	if c.Current == nil || c.Producer == nil || ctx.Err() != nil || c.Current(ctx, spec) != nil || ctx.Err() != nil {
		return refuse("stale_owner")
	}
	return nil
}

// call describes one exchange. Growth calls are sent at most once: after the
// journal says "sent", only a receipt lookup with the same target may recover.
type call struct {
	name    string
	path    string
	finite  bool
	growth  bool
	cleanup bool // allowed after cancellation (release and cancel)
	request []byte
	lookup  *benchworkspace.ReceiptLookupRequest
}

func (k call) contentType() string {
	if k.finite {
		return benchworkspace.FiniteContentType
	}
	return "application/json"
}
func (k call) limit() int {
	switch {
	case k.finite:
		return benchworkspace.MaxFiniteBody
	case k.growth:
		return benchworkspace.MaxBody
	case k.path == benchworkspace.PathRegistration:
		return benchworkspace.MaxBody
	}
	return benchworkspace.MaxResponse
}

// uncertain reports the producer's in-flight answers. They are never final:
// growth calls recover through the receipt, other calls may be sent again.
func uncertain(body []byte) bool {
	var peek struct {
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &peek) != nil || peek.Error == nil {
		return false
	}
	switch peek.Error.Code {
	case "in_progress", "operation_in_doubt", "unavailable":
		return true
	}
	return false
}

// send returns the journaled reply for k, obtaining it at most once.
func (c Coordinator) send(ctx context.Context, spec benchdispatch.SourceSpec, k call) (int, []byte, error) {
	var status int
	var body []byte
	transmit, lookup := false, false
	err := c.Journal.withRecord(ctx, spec, func(r *record, active bool) (bool, error) {
		s := r.step(k.name)
		if s != nil && string(s.Request) != string(k.request) {
			return false, refuse("conflict")
		}
		if s != nil && s.Response != nil {
			status, body = s.Status, append([]byte(nil), s.Response...)
			return false, nil
		}
		if !active {
			return false, refuse("stale_owner")
		}
		if s != nil && s.Sent && k.growth {
			lookup = true // read-only, so still allowed after cancellation
			return false, nil
		}
		if r.Cancelled && !k.cleanup {
			return false, refuse("stale_owner")
		}
		if c.current(ctx, spec) != nil {
			return false, refuse("stale_owner")
		}
		if s == nil {
			r.Steps = append(r.Steps, step{Name: k.name, Request: append([]byte(nil), k.request...)})
			s = &r.Steps[len(r.Steps)-1]
		}
		s.Sent = true
		transmit = true
		return true, nil
	})
	if err != nil || body != nil {
		return status, body, err
	}
	if lookup {
		status, body, err = c.recover(ctx, k)
	} else if transmit {
		status, body, err = c.Producer.Post(ctx, k.path, k.contentType(), k.request, k.limit())
	}
	if err != nil {
		return 0, nil, benchdispatch.ErrPending
	}
	if uncertain(body) {
		return 0, nil, benchdispatch.ErrPending
	}
	// Journal the actual reply even when ctx ended during transport.
	save, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = c.Journal.withRecord(save, spec, func(r *record, _ bool) (bool, error) {
		s := r.step(k.name)
		if s == nil {
			return false, benchdispatch.ErrInvalid
		}
		if s.Response != nil {
			status, body = s.Status, append([]byte(nil), s.Response...)
			return false, nil
		}
		s.Status, s.Response = status, append([]byte(nil), body...)
		return true, nil
	})
	if err != nil {
		return 0, nil, benchdispatch.ErrPending
	}
	return status, body, nil
}

// recover asks the producer's receipt store for the original reply. Only a
// completed receipt is an answer; absence, progress or doubt stay parked.
func (c Coordinator) recover(ctx context.Context, k call) (int, []byte, error) {
	if k.lookup == nil {
		return 0, nil, benchdispatch.ErrPending
	}
	raw, err := json.Marshal(k.lookup)
	if err != nil {
		return 0, nil, benchdispatch.ErrInvalid
	}
	limit := benchworkspace.MaxReceiptLookupResponse
	if k.finite {
		limit = benchworkspace.MaxFiniteLookup
	}
	status, body, err := c.Producer.Post(ctx, benchworkspace.PathReceipts, k.contentType(), raw, limit)
	if err != nil {
		return 0, nil, benchdispatch.ErrPending
	}
	parse := benchworkspace.ParseReceiptLookupResponse
	if k.finite {
		parse = benchworkspace.ParseFiniteReceiptLookupResponse
	}
	reply, err := parse(body, status, *k.lookup)
	if err != nil || !reply.OK || reply.Result.State != "completed" {
		return 0, nil, benchdispatch.ErrPending
	}
	return reply.Result.HTTPStatus, []byte(reply.Result.ResponseBody), nil
}

// mark changes the record under the lock. It never sends.
func (c Coordinator) mark(ctx context.Context, spec benchdispatch.SourceSpec, fn func(*record) bool) error {
	save, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if ctx.Err() == nil {
		save = ctx
	}
	return c.Journal.withRecord(save, spec, func(r *record, _ bool) (bool, error) { return fn(r), nil })
}

// terminate records a terminal refusal. held says whether this attempt still
// owns a lease that it must release; release is attempted, then retried by
// later status calls until it succeeds.
func (c Coordinator) terminate(ctx context.Context, spec benchdispatch.SourceSpec, code string, held bool) error {
	_ = c.mark(ctx, spec, func(r *record) bool {
		if r.Phase == phaseRefused || r.Phase == phaseCompleted {
			return false
		}
		r.Phase, r.Code = phaseRefused, code
		if held && r.Release != "done" {
			r.Release = "needed"
		} else if !held && r.Release == "needed" {
			r.Release = "done"
		}
		return true
	})
	_ = c.cleanup(ctx, spec)
	if r, _, err := c.Journal.read(ctx, spec); err == nil && r.Phase == phaseRefused {
		return refuse(r.Code)
	}
	return refuse(code)
}
