package benchbridge

import (
	"context"
	"errors"
	"reflect"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchremote"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// remote serves attach and finish, the remote launch's two operations. Only a
// remote-v1 profile answers them; any other launch refuses unsupported. Each
// first asks the hub (current phase "attach" or "finish") whether this exact
// request for this exact binding is current, then drives the attempt's own
// journal record.
func (h *Handler) remote(ctx context.Context, r benchcoordinatorwire.Request, raw []byte, p LocalProfile, intent Intent) (benchcoordinatorwire.Response, error) {
	if p.Launch != benchremote.Mode {
		response := refused(r.Operation)
		response.Code = "unsupported"
		return response, nil
	}
	if intent.Spec == nil || intent.Launch != benchremote.Mode {
		return pending(r), ErrIntent
	}
	prospective := intent
	prospective.ExecuteRequest, prospective.ExecuteSHA256 = string(raw), rawSHA(raw)
	if err := h.check(ctx, r, p, prospective, r.Operation); errors.Is(err, ErrStale) {
		return staleOwner(r), nil
	} else if err != nil {
		return refused(r.Operation), ErrCurrent
	}
	m, ok := h.manager(r, p, prospective, r.Operation).(benchremote.Coordinator)
	if !ok {
		return refused(r.Operation), ErrRegistry
	}
	saved, err := m.Reserved(ctx, *intent.Spec)
	if err != nil || !reflect.DeepEqual(saved, *intent.Spec) {
		return pending(r), ErrIntent
	}
	if r.Operation == "attach" {
		credential, err := m.Attach(ctx, saved, r.BindingSHA256, r.PublicKey)
		if err != nil {
			return failed(r, err)
		}
		return attachedResponse(r, credential)
	}
	completion, err := m.Finish(ctx, saved, r.BindingSHA256, benchremote.Report{Handoff: r.Report.Handoff, Outcome: r.Report.Outcome})
	if err != nil {
		return failed(r, err)
	}
	return completedResponse(r, saved, completion)
}

// attachedResponse carries the certificate and what the agent's SSH client
// needs. benchd's reply never held the lease token, and nothing here adds it.
func attachedResponse(r benchcoordinatorwire.Request, c benchworkspace.RemoteCredential) (benchcoordinatorwire.Response, error) {
	response := pending(r)
	response.State = "attached"
	response.Credential = &benchcoordinatorwire.RemoteCredential{Certificate: c.Certificate, User: c.User, Address: c.Address, HostKey: c.HostKey,
		HostKeyFingerprint: c.HostKeyFingerprint, LeaseID: c.LeaseID, Generation: c.Generation, ValidBefore: c.ValidBefore.UTC().Format(time.RFC3339Nano),
		WorkingDirectory: c.WorkingDirectory}
	return checkedResponse(r, response)
}
