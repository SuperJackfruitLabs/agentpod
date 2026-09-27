// External test package (gateway_test) on purpose: these two tests drive the
// matrix.adopt handler against the REAL Hermes profile writer and the REAL
// identity reader, and `descriptor` imports `gateway`. An in-package test
// importing it would be an import cycle — which is also why matrixadopt.go
// takes its writer and reader as injected funcs in the first place.
package gateway_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// adoptPassthrough stands in for the rest of the handler chain.
func adoptPassthrough() gateway.Handler {
	return gateway.HandlerFunc(func(_ context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		return "inner:" + verb, false, nil
	})
}

// TestAdoptReportsTheIdentityTheProfileNowReadsAs is the whole-branch
// review's Critical, from the side that starts it.
//
// Design §4 step 5 said "the node reports the new mxid on its next detect".
// There is no next detect: this verb restarts the HARNESS, not the
// node-agent, so the websocket whose open triggers the hub's capability
// refresh never reopens, and nothing else on the node→hub channel carries an
// mxid. Before this field existed the result was `{accepted:true}` and the
// hub's `stations.matrix_id` stayed stale forever — the station worked, the
// old credential stayed live, and nothing was ever recorded against the
// principal.
//
// This drives the REAL handler with the REAL Hermes writer and the REAL
// reader over a real profile directory, so it fails if the writer and the
// reader ever stop agreeing about where a Hermes identity lives.
func TestAdoptReportsTheIdentityTheProfileNowReadsAs(t *testing.T) {
	const newMxid = "@agent_writer-quill:id.agentpod.dev"

	// A realistic Hermes profile: both credential keys present with stale
	// values (which is every station this slice moves), plus adjacent config.
	dir := t.TempDir()
	env := "" +
		"MATRIX_USER_ID=@agent_guild_hermes-writer-quill:id.agentpod.dev\n" +
		"MATRIX_ACCESS_TOKEN=syt_old\n" +
		"ANTHROPIC_API_KEY=sk-seeded\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}

	h := gateway.NewMatrixAdoptHandler(adoptPassthrough(), gateway.MatrixAdoptDeps{
		Resolver:        gateway.WorkspaceFunc(func(string) (string, error) { return dir, nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		// The production lookup, not a stub: descriptor.WriterFor("hermes").
		WriterFor: func(harness string) (gateway.ProfileWriteFunc, bool) {
			w, ok := descriptor.WriterFor(harness)
			if !ok {
				return nil, false
			}
			return w.Write, true
		},
		Fetch: func(context.Context, string) (gateway.MatrixCredential, error) {
			return gateway.MatrixCredential{UserID: newMxid, AccessToken: "syt_new", DeviceID: "DEV1"}, nil
		},
		Restart: func(string) error { return nil },
		// The production reader, not a stub.
		ReadIdentity: func(profileDir string) *string {
			return descriptor.MatrixIDFromProfile(profileDir, "")
		},
	})

	res, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"hermes:writer-quill","stationId":"station_db_id"}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	out, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("result = %#v, want a map", res)
	}
	if out["matrixId"] != newMxid {
		t.Fatalf(
			"result matrixId = %#v, want %q — without it the hub never sees this move converge",
			out["matrixId"], newMxid,
		)
	}

	// And it is the FILE that says so, not an echo of what was fetched.
	if got := descriptor.MatrixIDFromProfile(dir, ""); got == nil || *got != newMxid {
		t.Fatalf("the profile itself reads as %v, want %q", got, newMxid)
	}
}

// TestAdoptReportsNoIdentityWhenTheWriteLandedWhereTheReaderDoesNotLook: the
// read-back is a verification, not an echo. A writer that puts the credential
// somewhere the harness (and therefore the reader) never loads must report
// nothing rather than the mxid it meant to write — design §3's "the outage
// reproduced with a green signal in front of it".
func TestAdoptReportsNoIdentityWhenTheWriteLandedWhereTheReaderDoesNotLook(t *testing.T) {
	dir := t.TempDir()

	h := gateway.NewMatrixAdoptHandler(adoptPassthrough(), gateway.MatrixAdoptDeps{
		Resolver:        gateway.WorkspaceFunc(func(string) (string, error) { return dir, nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		// A writer that "succeeds" while writing somewhere nothing reads.
		WriterFor: func(string) (gateway.ProfileWriteFunc, bool) {
			return func(profileDir, mxid, accessToken string) error {
				return os.WriteFile(filepath.Join(profileDir, "somewhere-else.json"), []byte(mxid), 0o600)
			}, true
		},
		Fetch: func(context.Context, string) (gateway.MatrixCredential, error) {
			return gateway.MatrixCredential{UserID: "@agent_writer-quill:id.agentpod.dev", AccessToken: "syt_new"}, nil
		},
		Restart: func(string) error { return nil },
		ReadIdentity: func(profileDir string) *string {
			return descriptor.MatrixIDFromProfile(profileDir, "")
		},
	})

	res, _, err := h.Handle(t.Context(), "matrix.adopt", json.RawMessage(`{"key":"hermes:writer-quill","stationId":"station_db_id"}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	out := res.(map[string]any)
	if out["matrixId"] != nil {
		t.Fatalf(
			"result matrixId = %#v, want nil — echoing the fetched mxid here would tell the hub "+
				"a station converged onto an identity its harness never loads",
			out["matrixId"],
		)
	}
}
