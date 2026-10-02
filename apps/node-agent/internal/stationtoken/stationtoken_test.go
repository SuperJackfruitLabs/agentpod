package stationtoken

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// jwt builds an unsigned token with the given expiry. Signing is irrelevant here: this
// package never verifies, it only asks how long is left.
func jwt(exp time.Time) string {
	payload, _ := json.Marshal(map[string]any{"sub": "prn_x", "principalKind": "agent", "exp": exp.Unix()})
	return "aGRy." + base64.RawURLEncoding.EncodeToString(payload) + ".c2ln"
}

func TestWritesTheTokenAtRestrictivePermissions(t *testing.T) {
	// A credential on disk that another user can read is not a credential. The file is the
	// whole point of this package, so its mode is part of its contract.
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "chotu.jwt")
	if err := writeToken(path, "the-token"); err != nil {
		t.Fatalf("write: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %o, want 600", got)
	}
	b, _ := os.ReadFile(path)
	if strings.TrimSpace(string(b)) != "the-token" {
		t.Fatalf("content = %q", b)
	}
}

func TestNeedsRefresh(t *testing.T) {
	dir := t.TempDir()
	k := &Keeper{}

	// Absent: there is nothing to spend, so yes.
	if !k.needsRefresh(filepath.Join(dir, "absent.jwt")) {
		t.Fatal("an absent token must be refreshed")
	}

	// Unparsable: the point is to end up with a usable token, not to diagnose the old one.
	junk := filepath.Join(dir, "junk.jwt")
	os.WriteFile(junk, []byte("not-a-jwt"), 0o600)
	if !k.needsRefresh(junk) {
		t.Fatal("an unreadable token must be refreshed")
	}

	// Expiring inside the floor: replaced early, so a consumer reading at any moment has
	// minutes of validity rather than seconds.
	soon := filepath.Join(dir, "soon.jwt")
	os.WriteFile(soon, []byte(jwt(time.Now().Add(30*time.Second))), 0o600)
	if !k.needsRefresh(soon) {
		t.Fatal("a token inside the refresh floor must be refreshed")
	}

	// Comfortably alive: left alone, so a pass is not a mint storm.
	fresh := filepath.Join(dir, "fresh.jwt")
	os.WriteFile(fresh, []byte(jwt(time.Now().Add(4*time.Minute))), 0o600)
	if k.needsRefresh(fresh) {
		t.Fatal("a fresh token must be left alone")
	}

	// Already dead: refreshed, obviously — and this is the case a naive `exp > now` check
	// would get right while getting `soon` above wrong.
	dead := filepath.Join(dir, "dead.jwt")
	os.WriteFile(dead, []byte(jwt(time.Now().Add(-time.Minute))), 0o600)
	if !k.needsRefresh(dead) {
		t.Fatal("an expired token must be refreshed")
	}
}

func TestRefreshSpendsTheNodeCredentialAndWritesTheToken(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Write([]byte(`{"token":"` + jwt(time.Now().Add(5*time.Minute)) + `","expiresIn":300}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	path := filepath.Join(dir, "chotu.jwt")
	k := &Keeper{Hub: srv.URL, NodeID: "node_1", NodeSecret: "sek", Client: srv.Client()}
	if err := k.refresh(context.Background(), Want{StationID: "station_9", Path: path}); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	// The node's secret goes to the hub and nowhere else.
	if gotAuth != "Bearer node_1:sek" {
		t.Fatalf("auth = %q", gotAuth)
	}
	if gotPath != "/api/nodes/node_1/stations/station_9/token" {
		t.Fatalf("path = %q", gotPath)
	}
	// And it is NOT what landed on disk — the file holds the station token, not the secret.
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "sek") {
		t.Fatal("the node secret must never reach the token file")
	}
	if _, ok := expiryOf(strings.TrimSpace(string(b))); !ok {
		t.Fatalf("file does not hold a readable token: %q", b)
	}
}

func TestARefusalLeavesTheOldTokenAlone(t *testing.T) {
	// A hub that refuses must not cost the agent a credential it already had. Truncating on
	// failure would turn a transient 503 into "this agent has no identity".
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	dir := t.TempDir()
	path := filepath.Join(dir, "chotu.jwt")
	existing := jwt(time.Now().Add(4 * time.Minute))
	os.WriteFile(path, []byte(existing), 0o600)

	k := &Keeper{Hub: srv.URL, NodeID: "node_1", NodeSecret: "sek", Client: srv.Client()}
	err := k.refresh(context.Background(), Want{StationID: "station_9", Path: path})
	if err == nil {
		t.Fatal("a 403 must be reported")
	}
	if !strings.Contains(err.Error(), "403") {
		// The hub's refusals are distinct on purpose; the status has to travel.
		t.Fatalf("error should name the status, got %v", err)
	}
	b, _ := os.ReadFile(path)
	if strings.TrimSpace(string(b)) != existing {
		t.Fatal("a failed refresh must leave the previous token intact")
	}
}

func TestOnceSkipsStationsThatDoNotNeedIt(t *testing.T) {
	// The ticker runs every 30s and the TTL is 5m, so most passes must do nothing at all.
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{"token":"` + jwt(time.Now().Add(5*time.Minute)) + `"}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	fresh := filepath.Join(dir, "fresh.jwt")
	os.WriteFile(fresh, []byte(jwt(time.Now().Add(4*time.Minute))), 0o600)
	stale := filepath.Join(dir, "stale.jwt")

	k := &Keeper{Hub: srv.URL, NodeID: "n", NodeSecret: "s", Client: srv.Client(), Wants: []Want{
		{StationID: "station_fresh", Path: fresh},
		{StationID: "station_stale", Path: stale},
	}}
	k.once(context.Background())
	if calls != 1 {
		t.Fatalf("minted %d times, want 1 (only the stale station)", calls)
	}
	if _, err := os.Stat(stale); err != nil {
		t.Fatalf("the stale station's token was not written: %v", err)
	}
}
