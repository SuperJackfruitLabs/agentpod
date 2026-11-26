// Package benchlaunch is the PROPOSED registered launch for the dedicated bench
// coordinator: the worker's task reaches the payload only as finite stdin bytes
// and its result returns only as sealed stdout. See docs/BENCH_REGISTERED_LAUNCH.md.
// Nothing here is reachable unless an installed registry profile opts in.
package benchlaunch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// Mode is the registry profile value that selects this launch.
const Mode = "registered-v1"

// Producer is the one SuperBench seam. *benchworkspace.Client implements it:
// each call sends once and returns the complete bounded reply, or ErrLost.
type Producer interface {
	Post(ctx context.Context, path, contentType string, raw []byte, limit int) (int, []byte, error)
}

// Refusal is a terminal decision for the attempt, with a coordinator wire code.
// Message is SuperBench's own bounded refusal text, when it gave one; it says
// why, and never changes what the code means.
type Refusal struct {
	Code    string
	Message string
	// LeaseHeld: the record still holds its lease because SuperBench refused
	// the release. The record is retried, but an operator must reconcile.
	LeaseHeld bool
	// Task is the worker's own reason the task failed, when it gave one.
	Task string
}

func (r *Refusal) Error() string { return "registered launch refused: " + r.Code }
func refuse(code string) error   { return &Refusal{Code: code} }

// RefusalTask reports the worker's reason the task failed, carried by a
// terminal refusal.
func RefusalTask(err error) string {
	var r *Refusal
	if errors.As(err, &r) {
		return r.Task
	}
	return ""
}

// RefusalMessage reports the producer's message carried by a terminal refusal.
func RefusalMessage(err error) string {
	var r *Refusal
	if errors.As(err, &r) {
		return r.Message
	}
	return ""
}

// HeldLease is a wait on a lease an older record on the same card still holds
// because SuperBench refused its release. It is pending (errors.Is ErrPending);
// it only says why, so the hub can name the operator's path.
type HeldLease struct{ Message string }

func (h *HeldLease) Error() string { return "bench lease held after a refused release" }
func (h *HeldLease) Unwrap() error { return benchdispatch.ErrPending }

// HeldLeaseOf reports a wait on a held lease, with SuperBench's message.
func HeldLeaseOf(err error) (string, bool) {
	var h *HeldLease
	if errors.As(err, &h) {
		return h.Message, true
	}
	return "", false
}

// RefusalLeaseHeld reports a terminal refusal whose record still holds its
// lease after SuperBench refused the release.
func RefusalLeaseHeld(err error) bool {
	var r *Refusal
	return errors.As(err, &r) && r.LeaseHeld
}

// maxProducerMessage bounds SuperBench's message as its own envelope does
// (256 UTF-8 bytes); anything longer is cut at a rune boundary.
const maxProducerMessage = 256

// producerMessage keeps SuperBench's refusal text safe to carry: valid UTF-8,
// no control characters, whitespace collapsed, at most 256 bytes. SuperBench
// replies carry no grants, tokens or root paths; the hub redacts again.
func producerMessage(e *benchworkspace.APIError) string {
	if e == nil {
		return ""
	}
	return boundedText(e.Message)
}

// taskMessage is the worker's own reason a failed task gives in its result's
// handoff ("error"), made safe to carry as producerMessage makes SuperBench's.
// The worker reduces it to a closed form before it leaves the bench (for
// Hermes, a provider status and what it means); the hub redacts again.
func taskMessage(result superbench.WorkerResult) string {
	if result.Outcome != "failed" {
		return ""
	}
	return boundedText(result.Handoff["error"])
}

func boundedText(text string) string {
	var b strings.Builder
	space := false
	for _, r := range text {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.IsSpace(r) {
			space = b.Len() > 0
			continue
		}
		add := utf8.RuneLen(r)
		if space {
			add++
		}
		if b.Len()+add > maxProducerMessage {
			break
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// refusalOf is the record's own terminal refusal, with what SuperBench said.
func refusalOf(r record) error {
	message := r.Producer
	if message == "" {
		message = r.ReleaseRefusal
	}
	return &Refusal{Code: r.Code, Message: message, LeaseHeld: leaseHeld(r), Task: r.Task}
}

// leaseHeld is a record that still holds its lease after SuperBench refused
// at least one release of it.
func leaseHeld(r record) bool { return r.Release == "needed" && r.ReleaseFailures > 0 }

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
	// Remote selects the remote launch (benchremote): Prepare stops after the
	// baseline checkpoint and binds no run, Execute is unsupported, and a
	// cleanup stops the lease before it releases it. See remote.go.
	Remote bool
}

// ErrSuperseded is what Current returns when the hub has definitely decided
// this attempt is no longer current (an authenticated stale_owner decision).
// Only this error lets an attempt retire itself; an unreachable hub does not.
var ErrSuperseded = errors.New("bench attempt superseded by the hub")

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

// uncertain reports the producer's in-flight answers. A live reply with one of
// them is never final: growth calls recover through the receipt, other calls
// may be sent again. A reply replayed from a completed receipt is the
// operation's final outcome whatever its code (treaty: "A completed stored
// failure is final"), so a stored unavailable ends the call; only a stored
// operation_in_doubt still needs reconciliation and parks.
func uncertain(body []byte, replayed bool) bool {
	var peek struct {
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &peek) != nil || peek.Error == nil {
		return false
	}
	switch peek.Error.Code {
	case "in_progress", "operation_in_doubt":
		return true
	case "unavailable":
		return !replayed
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
		// A vetoed record may still clean up after itself (release, cancel)
		// without a current decision; every other send needs one.
		if (!k.cleanup || !r.Cancelled) && c.current(ctx, spec) != nil {
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
	replayed := false
	if lookup {
		status, body, err = c.recover(ctx, k)
		replayed = err == nil
	} else if transmit {
		status, body, err = c.Producer.Post(ctx, k.path, k.contentType(), k.request, k.limit())
	}
	if err != nil {
		if k.name == "run" && errors.Is(err, errCancelBarrier) {
			return 0, nil, err // still pending; advance decides whether the run is over
		}
		return 0, nil, benchdispatch.ErrPending
	}
	if uncertain(body, replayed) {
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

// errCancelBarrier is a receipt lookup answering cancel_requested: a
// cancellation barrier won the run's finalization race. SuperBench refuses to
// store the run's reply once the barrier is recorded (benchd logs
// receipt_save_failed "operation cancellation requested"), and the lookup
// never upgrades the barrier, so this receipt can never become completed. It
// is still pending (errors.Is ErrPending): only advance, which reads the
// bench, may end the record on it (see cancelledRun).
var errCancelBarrier = fmt.Errorf("run cancellation barrier holds; its receipt will never be stored: %w", benchdispatch.ErrPending)

// recover asks the producer's receipt store for the original reply. Only a
// completed receipt is an answer; absence, progress or doubt stay parked, and
// a cancellation barrier is reported as errCancelBarrier.
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
	if err == nil && reply.OK && reply.Result.State == "cancel_requested" {
		return 0, nil, errCancelBarrier
	}
	if err != nil || !reply.OK || reply.Result.State != "completed" {
		return 0, nil, benchdispatch.ErrPending
	}
	return reply.Result.HTTPStatus, []byte(reply.Result.ResponseBody), nil
}

// forget drops a journaled step so a later cleanup may send it again. Only
// token-scoped, repeatable steps (release) are ever forgotten.
func (c Coordinator) forget(ctx context.Context, spec benchdispatch.SourceSpec, name string) {
	_ = c.mark(ctx, spec, func(r *record) bool {
		for i := range r.Steps {
			if r.Steps[i].Name == name {
				r.Steps = append(r.Steps[:i], r.Steps[i+1:]...)
				return true
			}
		}
		return false
	})
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
	return c.terminateWith(ctx, spec, code, held, "", "")
}

// refused ends the record on a definite producer refusal, keeping its message.
func (c Coordinator) refused(ctx context.Context, spec benchdispatch.SourceSpec, e *benchworkspace.APIError, code string, held bool) error {
	return c.terminateWith(ctx, spec, code, held, producerMessage(e), "")
}

func (c Coordinator) terminateWith(ctx context.Context, spec benchdispatch.SourceSpec, code string, held bool, message, task string) error {
	_ = c.mark(ctx, spec, func(r *record) bool {
		if r.Phase == phaseRefused || r.Phase == phaseCompleted {
			return false
		}
		r.Phase, r.Code, r.Producer, r.Task = phaseRefused, code, message, task
		if held && r.Release != "done" {
			r.Release = "needed"
		} else if !held && r.Release == "needed" {
			r.Release = "done"
		}
		return true
	})
	_ = c.cleanup(ctx, spec)
	if r, _, err := c.Journal.read(ctx, spec); err == nil && r.Phase == phaseRefused {
		return refusalOf(r)
	}
	return &Refusal{Code: code, Message: message, Task: task}
}
