package benchbridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
)

func currentFixture(t *testing.T) benchcoordinatorwire.CurrentRequest {
	t.Helper()
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-current-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Requests []struct{ Value json.RawMessage }
	}
	if json.Unmarshal(raw, &fixture) != nil || len(fixture.Requests) == 0 {
		t.Fatal("current fixture invalid")
	}
	r, err := benchcoordinatorwire.ParseCurrentRequest(fixture.Requests[0].Value)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func decisionFor(t *testing.T, raw []byte) benchcoordinatorwire.CurrentResponse {
	t.Helper()
	r, err := benchcoordinatorwire.ParseCurrentRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(raw)
	now := uint64(time.Now().UnixMilli())
	return benchcoordinatorwire.CurrentResponse{Version: benchcoordinatorwire.CurrentVersion,
		Nonce: r.Nonce, RequestSHA256: hex.EncodeToString(h[:]), IssuedAtMs: now,
		ExpiresAtMs: now + 2000, Decision: "current"}
}

func TestCurrentUsesOnlyEnrolledIdentityAndExactFreshDecision(t *testing.T) {
	request := currentFixture(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/nodes/node-fixture/bench-coordinator/current" ||
			r.Header.Get("Authorization") != "Bearer node-fixture:synthetic-private" || r.Method != "POST" {
			t.Error("request did not use enrolled node endpoint/credential")
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 65537))
		decision := decisionFor(t, raw)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(decision); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	client, err := NewHubCurrent(server.URL, "node-fixture", "synthetic-private")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Check(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	request.Identity.NodeID, request.Target.NodeID = "foreign-node", "foreign-node"
	if err := client.Check(context.Background(), request); !errors.Is(err, ErrCurrent) {
		t.Fatal("foreign node was not refused")
	}
	if calls.Load() != 1 {
		t.Fatal("foreign identity reached enrolled callback")
	}
}

func TestCurrentRefusesReplayedDecisions(t *testing.T) {
	request := currentFixture(t)
	var first *benchcoordinatorwire.CurrentResponse
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if first == nil {
			x := decisionFor(t, raw)
			first = &x
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(first); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	client, _ := NewHubCurrent(server.URL, "node-fixture", "synthetic-private")
	defer client.Close()
	if err := client.Check(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if err := client.Check(context.Background(), request); !errors.Is(err, ErrCurrent) {
		t.Fatal("saved decision authorized a second nonce")
	}
}

func TestCurrentClosedRefusals(t *testing.T) {
	for _, mode := range []string{"nonce", "digest", "expired", "future", "lifetime", "refused", "compression", "cache", "oversize", "redirect", "malformed"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				d := decisionFor(t, raw)
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				switch mode {
				case "nonce":
					d.Nonce = strings.Repeat("f", 32)
				case "digest":
					d.RequestSHA256 = strings.Repeat("0", 64)
				case "expired":
					d.IssuedAtMs, d.ExpiresAtMs = 1, 2
				case "future":
					d.IssuedAtMs += 10000
					d.ExpiresAtMs += 10000
				case "lifetime":
					d.ExpiresAtMs += 10000
				case "refused":
					d.Decision, d.Code = "refused", "stale_owner"
				case "compression":
					w.Header().Set("Content-Encoding", "gzip")
				case "cache":
					w.Header().Del("Cache-Control")
				case "oversize":
					_, _ = io.WriteString(w, strings.Repeat(" ", 4097))
					return
				case "redirect":
					w.Header().Set("Location", "/must-not-follow")
					w.WriteHeader(307)
					return
				case "malformed":
					_, _ = io.WriteString(w, `{"decision":null}`)
					return
				}
				if err := json.NewEncoder(w).Encode(d); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			client, _ := NewHubCurrent(server.URL, "node-fixture", "synthetic-private")
			defer client.Close()
			if err := client.Check(context.Background(), currentFixture(t)); !errors.Is(err, ErrCurrent) ||
				err.Error() != "checkpoint current authority unavailable; retain attempt" {
				t.Fatal("unsafe or non-static refusal")
			}
		})
	}
}

func TestCurrentRejectsUntrustedOriginsAndCredentialShapes(t *testing.T) {
	for _, origin := range []string{"http://untrusted.test", "https://user:secret@hub.test", "https://hub.test/path", "https://hub.test?query", "https://hub.test#fragment"} {
		if _, err := NewHubCurrent(origin, "node-fixture", "synthetic-private"); !errors.Is(err, ErrCurrent) {
			t.Fatal("untrusted origin accepted")
		}
	}
	if _, err := NewHubCurrent("https://hub.test", "node/foreign", "synthetic-private"); !errors.Is(err, ErrCurrent) {
		t.Fatal("foreign path accepted")
	}
}
