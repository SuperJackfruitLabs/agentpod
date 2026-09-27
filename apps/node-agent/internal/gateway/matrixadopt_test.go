package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"testing"
)

// matrixAdoptPassthrough stands in for the rest of the handler chain.
func matrixAdoptPassthrough() Handler {
	return HandlerFunc(func(_ context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		return "inner:" + verb, false, nil
	})
}

// fakeWriter is a ProfileWriteFunc backer whose Write records the call (and
// its order relative to restart, via the shared calls slice) and returns a
// pre-set error.
func fakeWriter(calls *[]string, err error) ProfileWriteFunc {
	return func(profileDir, mxid, accessToken string) error {
		*calls = append(*calls, "write")
		return err
	}
}

func TestMatrixAdoptPassesOtherVerbsThrough(t *testing.T) {
	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver:   WorkspaceFunc(func(string) (string, error) { return "", errors.New("should not be called") }),
		HarnessFor: func(string) (string, error) { return "", errors.New("should not be called") },
		CapabilitiesFor: func(string) ([]string, error) {
			t.Fatal("capabilitiesFor should not be called for other verbs")
			return nil, nil
		},
		WriterFor: func(string) (ProfileWriteFunc, bool) {
			t.Fatal("writerFor should not be called for other verbs")
			return nil, false
		},
		Fetch: func(context.Context, string) (MatrixCredential, error) {
			t.Fatal("fetch should not be called for other verbs")
			return MatrixCredential{}, nil
		},
		Restart:      func(string) error { t.Fatal("restart should not be called for other verbs"); return nil },
		ReadIdentity: func(string) *string { t.Fatal("readIdentity should not be called for other verbs"); return nil },
	})
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got != "inner:health" {
		t.Errorf("got %v, want the inner handler's result", got)
	}
}

// TestAdoptRefusesUnsupportedHarness: a harness with no registered writer is
// refused before any HTTP call is made — fetching a credential this node
// cannot store would spend a live, single-use authorization for nothing.
func TestAdoptRefusesUnsupportedHarness(t *testing.T) {
	fetchCalled := false
	restartCalled := false

	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver:        WorkspaceFunc(func(string) (string, error) { return "/profiles/foo", nil }),
		HarnessFor:      func(string) (string, error) { return "openclaw", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		WriterFor:       func(harness string) (ProfileWriteFunc, bool) { return nil, false }, // no writer registered
		Fetch: func(context.Context, string) (MatrixCredential, error) {
			fetchCalled = true
			return MatrixCredential{}, nil
		},
		Restart:      func(string) error { restartCalled = true; return nil },
		ReadIdentity: func(string) *string { return nil },
	})

	_, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"openclaw:writer-quill","stationId":"station_test_id"}`), nil)
	if err == nil {
		t.Fatal("want an error when the harness has no profile writer")
	}
	if !strings.Contains(err.Error(), "openclaw") {
		t.Errorf("error %q should name the unsupported harness", err.Error())
	}
	if fetchCalled {
		t.Error("fetch was called for a harness with no writer — a credential was fetched that could never be stored")
	}
	if restartCalled {
		t.Error("restart was called even though nothing was written")
	}
}

// TestAdoptWritesThenRestarts is the order-correctness test the brief names
// as the one that matters most: a restart before the write reloads the OLD
// identity, and the station then reports the old mxid forever. A handler
// that restarted first (or restarted without checking write's error) would
// record "restart" before "write" in calls, or would restart despite a
// write failure — either failure mode is what this test exists to catch.
func TestAdoptWritesThenRestarts(t *testing.T) {
	var calls []string

	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver:        WorkspaceFunc(func(key string) (string, error) { return "/profiles/writer-quill", nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		WriterFor: func(harness string) (ProfileWriteFunc, bool) {
			if harness != "hermes" {
				return nil, false
			}
			return fakeWriter(&calls, nil), true
		},
		Fetch: func(context.Context, string) (MatrixCredential, error) {
			return MatrixCredential{UserID: "@agent_writer-quill:id.agentpod.dev", AccessToken: "syt_secret"}, nil
		},
		Restart: func(string) error {
			calls = append(calls, "restart")
			return nil
		},
		ReadIdentity: func(string) *string {
			calls = append(calls, "read")
			mxid := "@agent_writer-quill:id.agentpod.dev"
			return &mxid
		},
	})

	res, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"hermes:writer-quill","stationId":"station_test_id"}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	accepted, ok := res.(map[string]any)
	if !ok || accepted["accepted"] != true {
		t.Errorf("result = %#v, want accepted:true", res)
	}

	// Write, restart, THEN read back. The read is last on purpose: it answers
	// "what does this profile say now", and asking it before the restart would
	// still be a fact about the file rather than about the running harness —
	// but asking it before the WRITE would answer about the old identity.
	want := []string{"write", "restart", "read"}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] || calls[2] != want[2] {
		t.Fatalf("calls = %v, want %v (write before restart — a restart before the write reloads the OLD identity)", calls, want)
	}
}

// TestAdoptFetchesByStationIdNotKey is Defect 2's regression test. The node
// knows station KEYS (hermes:writer-quill) and uses them to resolve a
// profile directory; the hub's redemption endpoint
// (POST /api/nodes/:nodeId/stations/:stationId/matrix-credential) is keyed
// by the station's DATABASE id instead — a different, unrelated string.
// Building the hub URL from the key would 403/404 against a hub that has no
// station by that name.
func TestAdoptFetchesByStationIdNotKey(t *testing.T) {
	var fetchedWith string

	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver: WorkspaceFunc(func(key string) (string, error) {
			if key != "hermes:writer-quill" {
				t.Errorf("profile lookup used %q, want the station KEY", key)
			}
			return "/profiles/writer-quill", nil
		}),
		HarnessFor: func(key string) (string, error) {
			if key != "hermes:writer-quill" {
				t.Errorf("harness lookup used %q, want the station KEY", key)
			}
			return "hermes", nil
		},
		CapabilitiesFor: func(key string) ([]string, error) {
			if key != "hermes:writer-quill" {
				t.Errorf("capability lookup used %q, want the station KEY", key)
			}
			return []string{"lifecycle"}, nil
		},
		WriterFor: func(string) (ProfileWriteFunc, bool) {
			return func(string, string, string) error { return nil }, true
		},
		Fetch: func(_ context.Context, id string) (MatrixCredential, error) {
			fetchedWith = id
			return MatrixCredential{UserID: "@agent_writer-quill:id.agentpod.dev", AccessToken: "syt_secret"}, nil
		},
		Restart:      func(string) error { return nil },
		ReadIdentity: func(string) *string { return nil },
	})

	_, _, err := h.Handle(
		t.Context(),
		"matrix.adopt",
		json.RawMessage(`{"key":"hermes:writer-quill","stationId":"station_db_id_789"}`),
		nil,
	)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if fetchedWith != "station_db_id_789" {
		t.Errorf(
			"fetch was called with %q, want the station's database id %q — the hub's "+
				"redemption endpoint is keyed by id, not by the station key",
			fetchedWith, "station_db_id_789",
		)
	}
}

// TestAdoptRefusesMissingStationId: params with a key but no stationId are
// bad params, refused before any lookup — the same posture as a missing key.
func TestAdoptRefusesMissingStationId(t *testing.T) {
	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver:        WorkspaceFunc(func(string) (string, error) { t.Fatal("resolver should not be called"); return "", nil }),
		HarnessFor:      func(string) (string, error) { t.Fatal("harnessFor should not be called"); return "", nil },
		CapabilitiesFor: func(string) ([]string, error) { t.Fatal("capabilitiesFor should not be called"); return nil, nil },
		WriterFor:       func(string) (ProfileWriteFunc, bool) { t.Fatal("writerFor should not be called"); return nil, false },
		Fetch: func(context.Context, string) (MatrixCredential, error) {
			t.Fatal("fetch should not be called")
			return MatrixCredential{}, nil
		},
		Restart:      func(string) error { t.Fatal("restart should not be called"); return nil },
		ReadIdentity: func(string) *string { t.Fatal("readIdentity should not be called"); return nil },
	})

	_, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"hermes:writer-quill"}`), nil)
	if err == nil {
		t.Fatal("want an error when stationId is missing")
	}
}

// TestAdoptDoesNotRestartWhenTheWriteFails: a failed write must not be
// followed by a restart — restarting anyway would tear the station down
// without ever handing it the identity it was supposed to come back up with.
func TestAdoptDoesNotRestartWhenTheWriteFails(t *testing.T) {
	var calls []string
	restartCalled := false

	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver:        WorkspaceFunc(func(string) (string, error) { return "/profiles/writer-quill", nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		WriterFor: func(string) (ProfileWriteFunc, bool) {
			return fakeWriter(&calls, errors.New("profile has never held a credential")), true
		},
		Fetch: func(context.Context, string) (MatrixCredential, error) {
			return MatrixCredential{UserID: "@agent_writer-quill:id.agentpod.dev", AccessToken: "syt_secret"}, nil
		},
		Restart:      func(string) error { restartCalled = true; return nil },
		ReadIdentity: func(string) *string { t.Fatal("readIdentity should not be called after a failed write"); return nil },
	})

	_, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"hermes:writer-quill","stationId":"station_test_id"}`), nil)
	if err == nil {
		t.Fatal("want an error when the write fails")
	}
	if restartCalled {
		t.Error("restart was called after a failed write")
	}
	if len(calls) != 1 || calls[0] != "write" {
		t.Errorf("calls = %v, want exactly one write attempt", calls)
	}
}

// TestAdoptNeverLogsTheToken captures the standard logger's output across a
// full successful adopt and asserts the fetched access token never appears
// in it — matrix.go's SECURITY note (the reader never touches access_token)
// applies just as hard here, where the token IS handled directly.
func TestAdoptNeverLogsTheToken(t *testing.T) {
	const secretToken = "syt_never_logged_zzz9K2"

	var buf bytes.Buffer
	prevOutput := log.Writer()
	prevFlags := log.Flags()
	log.SetOutput(&buf)
	defer func() {
		log.SetOutput(prevOutput)
		log.SetFlags(prevFlags)
	}()

	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver:        WorkspaceFunc(func(string) (string, error) { return "/profiles/writer-quill", nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		WriterFor: func(string) (ProfileWriteFunc, bool) {
			return func(profileDir, mxid, accessToken string) error { return nil }, true
		},
		Fetch: func(context.Context, string) (MatrixCredential, error) {
			return MatrixCredential{UserID: "@agent_writer-quill:id.agentpod.dev", AccessToken: secretToken, DeviceID: "DEV1"}, nil
		},
		Restart: func(string) error { return nil },
		ReadIdentity: func(string) *string {
			mxid := "@agent_writer-quill:id.agentpod.dev"
			return &mxid
		},
	})

	if _, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"hermes:writer-quill","stationId":"station_test_id"}`), nil); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	logged := buf.String()
	if logged == "" {
		t.Fatal("nothing was logged — this test proves nothing without a real log line to inspect")
	}
	if strings.Contains(logged, secretToken) {
		t.Errorf("the access token appeared in the log output: %q", logged)
	}
}

// TestAdoptNeverLogsTheTokenOnFailure: the same guarantee holds on the
// refusal path, where the fetched credential's token is discarded rather
// than written — an error string built carelessly from the credential could
// still leak it.
func TestAdoptNeverLogsTheTokenOnFailure(t *testing.T) {
	const secretToken = "syt_never_logged_on_failure_9Q"

	var buf bytes.Buffer
	prevOutput := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prevOutput)

	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver:        WorkspaceFunc(func(string) (string, error) { return "/profiles/writer-quill", nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		WriterFor: func(string) (ProfileWriteFunc, bool) {
			return func(profileDir, mxid, accessToken string) error {
				return errors.New("profile has never held a credential")
			}, true
		},
		Fetch: func(context.Context, string) (MatrixCredential, error) {
			return MatrixCredential{UserID: "@agent_writer-quill:id.agentpod.dev", AccessToken: secretToken}, nil
		},
		Restart:      func(string) error { return nil },
		ReadIdentity: func(string) *string { return nil },
	})

	_, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"hermes:writer-quill","stationId":"station_test_id"}`), nil)
	if err == nil {
		t.Fatal("want an error when the write fails")
	}
	if strings.Contains(err.Error(), secretToken) {
		t.Errorf("the access token appeared in the returned error: %q", err.Error())
	}
	if strings.Contains(buf.String(), secretToken) {
		t.Errorf("the access token appeared in the log output: %q", buf.String())
	}
}

// TestAdoptRefusesAStationWithNoLifecycleCapability is the #273 guard.
//
// A Hermes profile that shares the root gateway's Matrix identity has
// `lifecycle` withheld (descriptor/hermes.go) because it is a VIEW onto the
// agent the root gateway already runs, not a separately startable one —
// starting it would put a second gateway on one messaging identity. Such a
// station still answers as something other than the address its agent's handle
// implies, so the console offers it the move; this verb used to call restart
// without ever asking.
//
// The refusal is before the fetch, so a live single-use authorization is not
// spent on a station that could never converge.
func TestAdoptRefusesAStationWithNoLifecycleCapability(t *testing.T) {
	fetchCalled, restartCalled := false, false

	h := NewMatrixAdoptHandler(matrixAdoptPassthrough(), MatrixAdoptDeps{
		Resolver:   WorkspaceFunc(func(string) (string, error) { return "/profiles/writer-quill", nil }),
		HarnessFor: func(string) (string, error) { return "hermes", nil },
		// Everything a Hermes profile view gets EXCEPT lifecycle.
		CapabilitiesFor: func(string) ([]string, error) {
			return []string{"files", "logs", "health"}, nil
		},
		WriterFor: func(string) (ProfileWriteFunc, bool) {
			return func(string, string, string) error {
				t.Fatal("the profile was written for a station that may not be restarted")
				return nil
			}, true
		},
		Fetch: func(context.Context, string) (MatrixCredential, error) {
			fetchCalled = true
			return MatrixCredential{}, nil
		},
		Restart:      func(string) error { restartCalled = true; return nil },
		ReadIdentity: func(string) *string { return nil },
	})

	_, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"hermes:writer-quill","stationId":"station_db_id"}`), nil)
	if err == nil {
		t.Fatal("want a refusal for a station with no lifecycle capability")
	}
	if !strings.Contains(err.Error(), "lifecycle") {
		t.Errorf("error %q should name the capability it refused on", err.Error())
	}
	if restartCalled {
		t.Error("restart was called on a station whose lifecycle capability is deliberately withheld (issue #273)")
	}
	if fetchCalled {
		t.Error("a live single-use authorization was spent on a station that could never converge")
	}
}
