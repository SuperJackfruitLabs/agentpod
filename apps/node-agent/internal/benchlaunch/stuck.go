package benchlaunch

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// A bench stuck before ready is one whose create never finished: the key's
// workspace is still materializing or initializing under its initialization
// owner. A lease is refused there for good. SuperBench lets a create with a
// new request ID make the key's next generation once that owner is stopped
// and the host frees the old tree; until then the create is a conflict.

// Parked reasons. A parked record sends nothing more; it waits for the hub to
// supersede it with a later attempt, which looks at the bench again.
const (
	// parkStuck: the initialization owner is not one this node holds, so it
	// is not ours to stop. An operator's stop_admin frees it.
	parkStuck = "bench_stuck"
	// parkRefused: the owner is stopped, but SuperBench refused the create
	// with a conflict: the host has not freed the old tree yet.
	parkRefused = "recreate_refused"
)

// ErrBenchStuck parks a prepare whose bench is stuck under an owner we do not hold.
var ErrBenchStuck = fmt.Errorf("bench stuck before ready under an initialization owner this node does not hold: %w", benchdispatch.ErrPending)

// ErrRecreateRefused parks a prepare whose create on a stuck bench was refused.
var ErrRecreateRefused = fmt.Errorf("bench stuck before ready and not recoverable yet: %w", benchdispatch.ErrPending)

// stuck reports a workspace that never became ready and is still held only by
// its initialization owner.
func stuck(w *benchworkspace.WorkspaceInventory) bool {
	return w != nil && (w.Phase == "materializing" || w.Phase == "initializing") && w.Lease != nil && w.Lease.Holder == "initialization"
}

// recoverStuck runs before this attempt's create. When the key's bench is
// stuck it stops the initialization owner if this node holds it, then lets
// the create go out. Nothing here is sent twice: the create and the stop
// are journaled steps, the create's lost reply is read from its receipt, and
// a lost stop reply is settled only by a status read showing the owner
// stopped.
func (c Coordinator) recoverStuck(ctx context.Context, spec benchdispatch.SourceSpec) error {
	r, _, err := c.Journal.read(ctx, spec)
	if err != nil {
		return benchdispatch.ErrPending
	}
	w, ok := c.inspect(ctx, spec)
	if !ok {
		return benchdispatch.ErrPending
	}
	if r.Stuck == "" {
		if !stuck(w) {
			return nil // absent, reclaimed or anything else: the create decides
		}
		if c.mark(ctx, spec, func(r *record) bool {
			if r.Stuck != "" {
				return false
			}
			r.Stuck = w.BenchID
			return true
		}) != nil {
			return benchdispatch.ErrPending
		}
		r.Stuck = w.BenchID
	}
	if !stuck(w) || w.BenchID != r.Stuck || w.Lease.StopRequested {
		// The owner is stopped (by us or an operator), or the generation
		// moved on: whatever parked this attempt here no longer holds it.
		return c.unpark(ctx, spec, parkStuck)
	}
	if stop := r.step("stop"); stop != nil && stop.Sent && stop.Response == nil {
		// The stop's reply was lost and the owner still shows running. A stop
		// has no receipt; it is not resent by this attempt.
		return benchdispatch.ErrPending
	}
	token, err := c.initializationToken(ctx, spec, r.Stuck)
	if err != nil {
		return err
	}
	if token == "" {
		return c.park(ctx, spec, parkStuck)
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "stop", Key: spec.BenchKey, LeaseToken: token}
	// A journaled reply is replayed, never resent. The parser admits a
	// successful stop only with the owner stopped. A refused stop means the
	// token is no longer the owner's: the owner is not ours to stop.
	reply, err := c.ordinary(ctx, spec, "stop", request, false)
	if err != nil {
		return err
	}
	if !reply.OK {
		return c.park(ctx, spec, parkStuck)
	}
	return nil
}

// initializationToken finds the initialization owner's token for generation
// id in this key's journal: a create of an earlier attempt that failed and
// returned its initialization grant. A create whose reply was lost is read
// from its receipt. Only a completed, failed create with that grant counts;
// anything else proves nothing and yields no token.
func (c Coordinator) initializationToken(ctx context.Context, spec benchdispatch.SourceSpec, id string) (string, error) {
	self := recordID(spec)
	var creates []step
	err := c.Journal.update(ctx, spec.BenchKey, func(doc *document) (bool, error) {
		for i := range doc.Records {
			if doc.Records[i].ID == self {
				continue
			}
			if s := doc.Records[i].step("create"); s != nil && s.Sent {
				creates = append(creates, step{Request: append([]byte(nil), s.Request...), Status: s.Status, Response: append([]byte(nil), s.Response...)})
			}
		}
		return false, nil
	})
	if err != nil {
		return "", benchdispatch.ErrPending
	}
	for i := len(creates) - 1; i >= 0; i-- {
		s := creates[i]
		request, err := benchworkspace.Parse(s.Request)
		if err != nil || request.Operation != "create" {
			continue
		}
		status, body := s.Status, s.Response
		if len(body) == 0 {
			lookup, err := benchworkspace.NewReceiptLookupRequest(request)
			if err != nil {
				continue
			}
			if status, body, err = c.recover(ctx, call{lookup: &lookup}); err != nil || uncertain(body) {
				continue
			}
		}
		// The parser admits a grant on a create only on a failed one, held
		// by its initialization owner.
		reply, err := benchworkspace.ParseResponse(body, status, request)
		m := mutationOf(reply)
		if err != nil || m == nil || m.Grant == nil || m.Workspace.BenchID != id {
			continue
		}
		return m.Grant.LeaseToken, nil
	}
	return "", nil
}

// inspect reads the key's one workspace. ok is false when the reply could not
// be read; a key with no workspace is ok with a nil workspace.
func (c Coordinator) inspect(ctx context.Context, spec benchdispatch.SourceSpec) (*benchworkspace.WorkspaceInventory, bool) {
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "status", Key: spec.BenchKey}
	raw, _ := json.Marshal(request)
	status, body, err := c.Producer.Post(ctx, benchworkspace.PathOperations, "application/json", raw, benchworkspace.MaxResponse)
	if err != nil {
		return nil, false
	}
	reply, err := benchworkspace.ParseResponse(body, status, request)
	inventory, ok := reply.Result.(*benchworkspace.Status)
	if err != nil || !ok || len(inventory.Benches) > 1 {
		return nil, false
	}
	if len(inventory.Benches) == 0 {
		return nil, true
	}
	w, ok := inventory.Benches[0].(*benchworkspace.WorkspaceInventory)
	return w, ok
}

// park records why this attempt waits and logs it once. It sends nothing.
func (c Coordinator) park(ctx context.Context, spec benchdispatch.SourceSpec, why string) error {
	first := false
	_ = c.mark(ctx, spec, func(r *record) bool {
		if r.Parked == why {
			return false
		}
		r.Parked, first = why, true
		return true
	})
	if why == parkRefused {
		if first {
			log.Printf("bench %s: stuck before ready and the create on it was refused; the card waits for a later attempt", spec.BenchKey)
		}
		return ErrRecreateRefused
	}
	if first {
		log.Printf("bench %s: stuck before ready under an initialization owner this node does not hold; an operator stop_admin frees it", spec.BenchKey)
	}
	return ErrBenchStuck
}

// unpark clears a park reason the attempt has moved past, so Status never
// reports a state it is no longer in.
func (c Coordinator) unpark(ctx context.Context, spec benchdispatch.SourceSpec, why string) error {
	if c.mark(ctx, spec, func(r *record) bool {
		if r.Parked != why {
			return false
		}
		r.Parked = ""
		return true
	}) != nil {
		return benchdispatch.ErrPending
	}
	return nil
}
