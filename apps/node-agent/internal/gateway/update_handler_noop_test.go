package gateway

// Issue #296: the hub-triggered "update" verb restarted a node that was
// already on the latest release. The node re-downloaded, re-swapped and
// bounced the service to arrive exactly where it started — and on Fly that
// bounce is a full VM reboot, so an idle click on Update costs a station its
// uptime and every in-flight session on it.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/selfupdate"
)

// newTestUpdateHandler builds an updateHandler whose apply is `fake` and whose
// exit signals the returned channel instead of killing the test binary.
func newTestUpdateHandler(
	version string,
	fake func(context.Context, selfupdate.Options) (selfupdate.Result, error),
) (*updateHandler, chan int) {
	exited := make(chan int, 1)
	h := &updateHandler{
		inner:   HandlerFunc(func(context.Context, string, json.RawMessage, func(int, string, bool, string) error) (any, bool, error) { return nil, false, nil }),
		version: version,
		apply:   fake,
		exit:    func(code int) { exited <- code },
		delay:   0,
	}
	return h, exited
}

// handleUpdate runs the update verb and returns the result map plus whether
// the process exited. The exit path is a goroutine, so "did not exit" is
// asserted by waiting — long enough that a slow scheduler cannot fake a pass.
func handleUpdate(t *testing.T, h *updateHandler, exited chan int, params string) (map[string]any, bool) {
	t.Helper()

	result, streamed, err := h.Handle(context.Background(), "update", json.RawMessage(params), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if streamed {
		t.Error("update must return streamed=false so the dispatcher emits a res frame the hub can resolve")
	}
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any result, got %T", result)
	}

	select {
	case <-exited:
		return m, true
	case <-time.After(500 * time.Millisecond):
		return m, false
	}
}

func TestUpdateHandler_AlreadyCurrentDoesNotRestart(t *testing.T) {
	var gotOpts selfupdate.Options
	h, exited := newTestUpdateHandler("v0.1.25", func(_ context.Context, opts selfupdate.Options) (selfupdate.Result, error) {
		gotOpts = opts
		// What Apply returns for a node already on the latest release.
		return selfupdate.Result{
			CurrentVersion: opts.CurrentVersion,
			LatestTag:      "v0.1.25",
			Updated:        false,
			Reason:         "already up to date",
		}, nil
	})

	m, didExit := handleUpdate(t, h, exited, `{}`)

	if didExit {
		t.Error("the process exited — an already-current node must not restart (on Fly that is a full VM reboot)")
	}
	if m["ok"] != true {
		t.Errorf("ok: got %v want true — being already current is a success, not a failure", m["ok"])
	}
	if m["updating"] != false {
		t.Errorf("updating: got %v want false — nothing was applied, so the response must not imply work happened", m["updating"])
	}
	if m["tag"] != "v0.1.25" {
		t.Errorf("tag: got %v want \"v0.1.25\"", m["tag"])
	}
	if m["currentVersion"] != "v0.1.25" {
		t.Errorf("currentVersion: got %v want \"v0.1.25\"", m["currentVersion"])
	}
	if m["reason"] != "already up to date" {
		t.Errorf("reason: got %v want \"already up to date\" — the console needs it to say so", m["reason"])
	}
	if gotOpts.CurrentVersion != "v0.1.25" {
		t.Errorf("CurrentVersion passed to Apply: got %q want \"v0.1.25\"", gotOpts.CurrentVersion)
	}
	if gotOpts.Force {
		t.Error("Force must default to false")
	}
}

func TestUpdateHandler_BehindStillRestarts(t *testing.T) {
	h, exited := newTestUpdateHandler("v0.1.9", func(_ context.Context, opts selfupdate.Options) (selfupdate.Result, error) {
		return selfupdate.Result{
			CurrentVersion: opts.CurrentVersion,
			LatestTag:      "v0.1.24",
			Updated:        true,
		}, nil
	})

	m, didExit := handleUpdate(t, h, exited, `{}`)

	if !didExit {
		t.Error("a node behind the latest release must still swap and exit for the supervisor to restart it")
	}
	if m["ok"] != true {
		t.Errorf("ok: got %v want true", m["ok"])
	}
	if m["updating"] != true {
		t.Errorf("updating: got %v want true", m["updating"])
	}
	if m["tag"] != "v0.1.24" {
		t.Errorf("tag: got %v want \"v0.1.24\"", m["tag"])
	}
}

// The escape hatch: `{"force":true}` re-applies the current release. Without
// it there is no way to recover a node whose binary is corrupt but whose
// reported version is current.
func TestUpdateHandler_ForceIsForwardedAndRestarts(t *testing.T) {
	var gotOpts selfupdate.Options
	h, exited := newTestUpdateHandler("v0.1.25", func(_ context.Context, opts selfupdate.Options) (selfupdate.Result, error) {
		gotOpts = opts
		if !opts.Force {
			return selfupdate.Result{LatestTag: "v0.1.25", Reason: "already up to date"}, nil
		}
		return selfupdate.Result{CurrentVersion: opts.CurrentVersion, LatestTag: "v0.1.25", Updated: true}, nil
	})

	m, didExit := handleUpdate(t, h, exited, `{"force":true}`)

	if !gotOpts.Force {
		t.Fatal("Force from the request params was not forwarded to selfupdate.Apply")
	}
	if !didExit {
		t.Error("a forced update must still exit so the supervisor restarts the process")
	}
	if m["updating"] != true {
		t.Errorf("updating: got %v want true", m["updating"])
	}
}

// A params payload the handler cannot read must not fail the update and must
// not be read as force — it is simply "no options given".
func TestUpdateHandler_UnreadableParamsDefaultToNoForce(t *testing.T) {
	for _, params := range []string{``, `null`, `"nonsense"`} {
		var gotOpts selfupdate.Options
		h, exited := newTestUpdateHandler("v0.1.9", func(_ context.Context, opts selfupdate.Options) (selfupdate.Result, error) {
			gotOpts = opts
			return selfupdate.Result{CurrentVersion: opts.CurrentVersion, LatestTag: "v0.1.24", Updated: true}, nil
		})

		m, _ := handleUpdate(t, h, exited, params)
		if gotOpts.Force {
			t.Errorf("params %q: Force must be false", params)
		}
		if m["ok"] != true {
			t.Errorf("params %q: ok: got %v want true", params, m["ok"])
		}
	}
}
