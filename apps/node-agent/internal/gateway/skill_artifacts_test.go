package gateway

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSkillArtifactFetchBindsExistingNodeAndOperation(t *testing.T) {
	payload := []byte("synthetic archive bytes")
	pin := fmt.Sprintf("%x", sha256.Sum256(payload))
	id := strings.Repeat("a", 32)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/nodes/node-fixture/stations/station-fixture/skill-artifacts/"+id || r.Header.Get("Authorization") != "Bearer node-fixture:synthetic-secret" || r.Header.Get("X-AgentPod-Station-Key") != "codex:fixture" {
			t.Errorf("incorrect bound request: %s %s", r.Method, r.URL.Path)
		}
		w.Write(payload)
	}))
	defer server.Close()
	fetch, err := NewHTTPArtifactFetcher(server.URL, "node-fixture", "synthetic-secret")
	if err != nil {
		t.Fatal(err)
	}
	data, err := fetch(context.Background(), SkillArtifactRequest{StationID: "station-fixture", StationKey: "codex:fixture", OperationID: id, ArchiveSHA256: pin})
	if err != nil || string(data) != string(payload) {
		t.Fatalf("fetch failed: %v", err)
	}
}

func TestSkillArtifactFetchRefusesRedirectsErrorsAndWrongBytes(t *testing.T) {
	for _, status := range []int{http.StatusFound, http.StatusForbidden, http.StatusOK} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var redirected atomic.Bool
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Store(true) }))
			defer target.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(status)
				w.Write([]byte("private-response-do-not-log"))
			}))
			defer server.Close()
			fetch, _ := NewHTTPArtifactFetcher(server.URL, "node-fixture", "synthetic-secret")
			_, err := fetch(context.Background(), SkillArtifactRequest{StationID: "station-fixture", StationKey: "codex:fixture", OperationID: strings.Repeat("a", 32), ArchiveSHA256: strings.Repeat("b", 64)})
			if err == nil || strings.Contains(err.Error(), "private-response") || strings.Contains(err.Error(), "synthetic-secret") {
				t.Fatalf("unsafe fetch result: %v", err)
			}
			if redirected.Load() {
				t.Fatal("credentials followed a redirect")
			}
		})
	}
}

func TestSkillArtifactFetchBoundsAndCancellation(t *testing.T) {
	request := SkillArtifactRequest{StationID: "station-fixture", StationKey: "codex:fixture", OperationID: strings.Repeat("a", 32), ArchiveSHA256: strings.Repeat("b", 64)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "33554433")
		w.WriteHeader(200)
	}))
	defer server.Close()
	fetch, _ := NewHTTPArtifactFetcher(server.URL, "node-fixture", "synthetic-secret")
	if _, err := fetch(context.Background(), request); err == nil {
		t.Fatal("oversized content length accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fetch(ctx, request); err == nil {
		t.Fatal("cancelled request accepted")
	}
	request.StationID = "../other"
	if _, err := fetch(context.Background(), request); err == nil {
		t.Fatal("path injection accepted")
	}
	for _, hub := range []string{"https://user:secret@example.com", "https://example.com?token=x", "file:///tmp/hub", "http://remote.example"} {
		if _, err := NewHTTPArtifactFetcher(hub, "node-fixture", "synthetic-secret"); err == nil {
			t.Fatalf("unsafe origin accepted: %s", hub)
		}
	}
}

func TestSkillArtifactFetchBoundsChunkedBodiesAndInFlightWait(t *testing.T) {
	request := SkillArtifactRequest{StationID: "station-fixture", StationKey: "codex:fixture", OperationID: strings.Repeat("a", 32), ArchiveSHA256: strings.Repeat("b", 64)}
	t.Run("chunked", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			chunk := make([]byte, 64<<10)
			for n := 0; n < 513; n++ {
				if _, err := w.Write(chunk); err != nil {
					return
				}
			}
		}))
		defer server.Close()
		fetch, _ := NewHTTPArtifactFetcher(server.URL, "node-fixture", "synthetic-secret")
		if _, err := fetch(context.Background(), request); err == nil || !strings.Contains(err.Error(), "exceeds limit") {
			t.Fatalf("unbounded streamed body: %v", err)
		}
	})
	t.Run("deadline", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
		defer server.Close()
		fetch, _ := NewHTTPArtifactFetcher(server.URL, "node-fixture", "synthetic-secret")
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		if _, err := fetch(ctx, request); err != context.DeadlineExceeded {
			t.Fatalf("deadline was not preserved: %v", err)
		}
	})
}
