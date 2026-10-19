package mcpproxy

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// Signature verification remains the upstream's. These tests exercise the node's additional
// identity binding over tokens supplied by its trusted TokenSource, using unsigned fixtures.
func identityToken(principal, org string) string {
	b, _ := json.Marshal(map[string]string{"sub": principal, "org": org, "principalKind": "agent"})
	return "e30." + base64.RawURLEncoding.EncodeToString(b) + ".fixture"
}
func TestBoundProxyCannotSubstituteAnotherStationOccupantAndKeepsItsFenceAfterRestart(t *testing.T) {
	const org = "org_00000000000000000001"
	const a = "prn_00000000000000000001"
	const b = "prn_00000000000000000002"
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(200) }))
	defer upstream.Close()
	token := identityToken(a, org)
	tokens := &fakeTokens{next: func(string) (string, error) { return token, nil }}
	path := filepath.Join(t.TempDir(), "proxy.json")
	start := func() *Proxy {
		p, err := Start(Config{Stations: []string{"s"}, HubURL: upstream.URL, Tokens: tokens, StatePath: path})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = p.Close() })
		return p
	}
	p := start()
	identity := Identity{BindingDigest: strings.Repeat("a", 64), OrganizationID: org, PrincipalID: a, OccupancyEpoch: 3}
	first, err := p.BindIdentity("s", identity)
	if err != nil {
		t.Fatal(err)
	}
	if statusOf(t, first[0]) != 200 || calls.Load() != 1 {
		t.Fatal("admitted station principal did not reach upstream")
	}
	if !strings.Contains(first[0].URL, "/mcp-managed-v1/"+identity.BindingDigest+"/") {
		t.Fatal("managed assignment reused the old transparent proxy namespace")
	}
	if statusOf(t, p.Servers("s")[0]) != 401 || calls.Load() != 1 {
		t.Fatal("a managed credential could use the unbound legacy route")
	}
	token = identityToken(b, org)
	if statusOf(t, first[0]) != 403 || calls.Load() != 1 {
		t.Fatal("a cached or freshly changed occupant was substituted for the admitted principal")
	}
	nextIdentity := Identity{BindingDigest: strings.Repeat("b", 64), OrganizationID: org, PrincipalID: b, OccupancyEpoch: 4}
	next, err := p.BindIdentity("s", nextIdentity)
	if err != nil {
		t.Fatal(err)
	}
	if next[0].CredentialGeneration <= first[0].CredentialGeneration {
		t.Fatal("identity handoff did not advance owned credential generation")
	}
	if statusOf(t, first[0]) != 401 {
		t.Fatal("old binding credential survived handoff")
	}
	if statusOf(t, next[0]) != 200 || calls.Load() != 2 {
		t.Fatal("new bound occupant failed")
	}
	if _, err := p.BindIdentity("s", identity); err == nil {
		t.Fatal("occupancy rollback was accepted")
	}
	p.Close()
	p = start()
	token = identityToken(a, org)
	if statusOf(t, next[0]) != 403 || calls.Load() != 2 {
		t.Fatal("node restart forgot the forwarding identity fence")
	}
	same, err := p.BindIdentity("s", nextIdentity)
	if err != nil {
		t.Fatal(err)
	}
	if same[0].CredentialGeneration != next[0].CredentialGeneration {
		t.Fatal("identical recovery rotated or replaced its assignment")
	}
}

func TestRotationDuringTokenMintCannotForwardTheOldCredential(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(200) }))
	defer upstream.Close()
	tokens := &fakeTokens{next: func(string) (string, error) {
		close(entered)
		<-release
		return identityToken("prn_00000000000000000001", "org_00000000000000000001"), nil
	}}
	p, err := Start(Config{Stations: []string{"s"}, HubURL: upstream.URL, Tokens: tokens})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	identity := Identity{BindingDigest: strings.Repeat("a", 64), OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000001", OccupancyEpoch: 1}
	first, err := p.BindIdentity("s", identity)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() {
		res := post(t, first[0].URL, secretOf(first[0]), nil)
		res.Body.Close()
		done <- res.StatusCode
	}()
	<-entered
	if _, err := p.Rotate([]string{"s"}); err != nil {
		t.Fatal(err)
	}
	close(release)
	if <-done != 401 || calls.Load() != 0 {
		t.Fatal("rotation during mint forwarded an outdated binding")
	}
}
