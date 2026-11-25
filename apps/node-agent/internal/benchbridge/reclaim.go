package benchbridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchremote"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// After the hub has a card's checkpoint settled (pushed to card/<id> and reported), it asks the node
// to reclaim that card's bench, so a settled card stops holding its tree and quota until SuperBench's
// idle sweep. A card that comes back later (a review bounce) finds the key reclaimed and gets a fresh
// bench prepared from its card branch: `choose` already creates over a reclaimed key.
const (
	VerbReclaim = "bench.reclaim"
	// ReclaimCapability says a node answers bench.reclaim.
	ReclaimCapability = "bench.reclaim"
)

// ReclaimRequest names a card on one stage's selector. The bench key is derived exactly as a prepare
// derives it, so no caller can name another card's bench.
type ReclaimRequest struct {
	TenantID  string `json:"tenant_id"`
	BoardID   string `json:"board_id"`
	StationID string `json:"station_id"`
	CardID    string `json:"card_id"`
}

// ReclaimReply is what happened. State is closed: reclaimed, absent (no bench, or already reclaimed)
// or refused, with a closed Code. Nothing here carries a path, a token or SuperBench's own text.
type ReclaimReply struct {
	State   string `json:"state"`
	Code    string `json:"code,omitempty"`
	BenchID string `json:"bench_id,omitempty"`
}

var cardPattern = regexp.MustCompile(`^card_[A-Za-z0-9]{6,}$`)

// Reclaim is the node verb: the installed registry must be current and the selector one it serves.
func (h *Handler) Reclaim(ctx context.Context, req ReclaimRequest) (ReclaimReply, error) {
	// A registry that changed since this handler was built answers as unavailable, never as an error.
	if current := h.installed() == nil; !current {
		return ReclaimReply{State: "refused", Code: "unavailable"}, nil
	}
	return h.reclaim(ctx, req)
}

// settledOutcome turns the journal's answer into the reply: fn's own reply when the bench was
// settled, a closed refusal otherwise.
func settledOutcome(reply ReclaimReply, err error) ReclaimReply {
	switch {
	case err == nil:
		return reply
	case errors.Is(err, benchlaunch.ErrUnsettled):
		return ReclaimReply{State: "refused", Code: "unsettled"}
	default:
		return ReclaimReply{State: "refused", Code: "unavailable"}
	}
}

func (h *Handler) reclaim(ctx context.Context, req ReclaimRequest) (ReclaimReply, error) {
	if req.TenantID == "" || req.BoardID == "" || req.StationID == "" || !cardPattern.MatchString(req.CardID) {
		return ReclaimReply{}, errors.New("invalid reclaim request")
	}
	var profile *LocalProfile
	for i, p := range h.registry.Profiles {
		if p.TenantID == req.TenantID && p.BoardID == req.BoardID && p.StationID == req.StationID {
			profile = &h.registry.Profiles[i]
		}
	}
	// Only the registered and remote launches keep the per-bench journal that proves every attempt settled.
	if profile == nil || (profile.Launch != benchlaunch.Mode && profile.Launch != benchremote.Mode) {
		return ReclaimReply{State: "refused", Code: "unsupported"}, nil
	}
	stable, _ := json.Marshal([]string{req.TenantID, req.BoardID, req.CardID})
	key := "cp_" + rawSHA(stable)
	registered := filepath.Join(h.registry.StateRoot, "registered")
	remote := benchremote.JournalRoot(h.registry.StateRoot)
	_ = os.Mkdir(registered, 0700)
	_ = os.Mkdir(remote, 0700)
	// A stage can switch execution between a card's attempts, so the bench may hold records of either
	// launch: both journals must be settled, each under its own lock (taken in this order only here).
	var reply ReclaimReply
	err := benchlaunch.Journal{Root: registered}.WhileSettled(ctx, key, func() error {
		return benchremote.Journal{Root: remote}.WhileSettled(ctx, key, func() error {
			reply = h.reclaimSettled(ctx, key)
			return nil
		})
	})
	return settledOutcome(reply, err), nil
}

// reclaimSettled reads the bench first and sends reclaim only for a ready bench with no lease.
// SuperBench refuses anything else itself (409); asking first keeps a held lease untouched here too.
func (h *Handler) reclaimSettled(ctx context.Context, key string) ReclaimReply {
	status := benchworkspace.Request{Version: benchworkspace.Version, Operation: "status", Key: key}
	reply, err := h.client.Do(ctx, status)
	if reply != nil && benchworkspace.KeyAbsent(status, *reply) {
		return ReclaimReply{State: "absent"}
	}
	if err != nil || reply == nil || !reply.OK {
		return ReclaimReply{State: "refused", Code: "unavailable"}
	}
	inventory, ok := reply.Result.(*benchworkspace.Status)
	if !ok {
		return ReclaimReply{State: "refused", Code: "unavailable"}
	}
	var bench *benchworkspace.WorkspaceInventory
	for _, entry := range inventory.Benches {
		if w, ok := entry.(*benchworkspace.WorkspaceInventory); ok && w.Key == key {
			bench = w
		}
	}
	switch {
	case bench == nil || bench.Phase == "reclaimed":
		return ReclaimReply{State: "absent"}
	case bench.Lease != nil:
		return ReclaimReply{State: "refused", Code: "lease_held", BenchID: bench.BenchID}
	case bench.Phase != "ready" || bench.Pending != nil:
		return ReclaimReply{State: "refused", Code: "not_ready", BenchID: bench.BenchID}
	}
	request := benchworkspace.Request{Version: benchworkspace.Version, Operation: "reclaim", Key: key}
	out, err := h.client.Do(ctx, request)
	if err != nil || out == nil {
		return ReclaimReply{State: "refused", Code: "unavailable", BenchID: bench.BenchID}
	}
	if !out.OK {
		code := "unavailable"
		if out.Error != nil && (out.Error.Code == "conflict" || out.Error.Code == "forbidden") {
			code = out.Error.Code
		}
		return ReclaimReply{State: "refused", Code: code, BenchID: bench.BenchID}
	}
	if w, ok := out.Result.(*benchworkspace.Mutation); ok && w.Workspace.Phase == "reclaimed" {
		return ReclaimReply{State: "reclaimed", BenchID: w.Workspace.BenchID}
	}
	return ReclaimReply{State: "reclaimed", BenchID: bench.BenchID}
}
