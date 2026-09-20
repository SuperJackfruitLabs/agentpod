package fleetcred

// The device credential, and the one rule it must not break.
//
// `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`, accepted
// 2026-09-20. What matters here is less that the happy path works than that the fallbacks do
// not reach for something they must not, and that a stale cached token does not survive.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

/** A token whose exp is `d` from now, unsigned — Inspect never verifies. */
func tokenExpiringIn(t *testing.T, d time.Duration) string {
	t.Helper()
	payload := map[string]any{"exp": time.Now().Add(d).Unix(), "sub": "u1", "principalKind": "human"}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return "h." + b64url(b) + ".s"
}

func b64url(b []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	var out []byte
	for i := 0; i < len(b); i += 3 {
		var n uint32
		rem := len(b) - i
		n |= uint32(b[i]) << 16
		if rem > 1 {
			n |= uint32(b[i+1]) << 8
		}
		if rem > 2 {
			n |= uint32(b[i+2])
		}
		out = append(out, alphabet[(n>>18)&63], alphabet[(n>>12)&63])
		if rem > 1 {
			out = append(out, alphabet[(n>>6)&63])
		}
		if rem > 2 {
			out = append(out, alphabet[n&63])
		}
	}
	return string(out)
}

func TestSaveAndLoadDevice(t *testing.T) {
	withConfigDir(t)
	want := Device{ID: "dev_0123456789abcdef0123", Secret: "s3cret", Hub: "https://hub.test", Name: "laptop"}
	if err := SaveDevice(want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadDevice()
	if err != nil {
		t.Fatalf("LoadDevice: %v", err)
	}
	if got.ID != want.ID || got.Secret != want.Secret || got.Hub != want.Hub {
		t.Fatalf("round trip lost something: %+v", got)
	}
}

// The secret is on disk for ninety days. 0600 is the whole of what protects it from another
// account on the same machine.
func TestDeviceFileIsNotWorldReadable(t *testing.T) {
	withConfigDir(t)
	if err := SaveDevice(Device{ID: "dev_x", Secret: "s"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(DevicePath())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("device file is %o, want 600", perm)
	}
	dirInfo, err := os.Stat(filepath.Dir(DevicePath()))
	if err != nil {
		t.Fatal(err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("config dir is %o, want 700", perm)
	}
}

// A half-written or hand-edited file is "no device", not an error: the operator's next move is
// `fleet login` in every one of those cases.
func TestMalformedDeviceFileReadsAsAbsent(t *testing.T) {
	withConfigDir(t)
	for _, body := range []string{"not json", `{}`, `{"id":"dev_x"}`, `{"secret":"s"}`, `{"id":"","secret":""}`} {
		if err := os.MkdirAll(filepath.Dir(DevicePath()), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(DevicePath(), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadDevice(); err != ErrNoDevice {
			t.Fatalf("body %q: want ErrNoDevice, got %v", body, err)
		}
	}
}

func TestResolvePrefersTheEnvironmentAndNeverTouchesTheNetwork(t *testing.T) {
	withConfigDir(t)
	t.Setenv(EnvToken, "supplied-token")
	// A device credential pointing at a server that fails the test if it is called.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("Resolve reached the hub despite %s being set", EnvToken)
	}))
	defer srv.Close()
	if err := SaveDevice(Device{ID: "dev_x", Secret: "s", Hub: srv.URL}); err != nil {
		t.Fatal(err)
	}

	c, err := Resolve(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if c.Token != "supplied-token" {
		t.Fatalf("got %q", c.Token)
	}
}

func TestResolveExchangesWhenTheCachedTokenHasExpired(t *testing.T) {
	withConfigDir(t)
	var authSeen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authSeen = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"fresh-token"}`))
	}))
	defer srv.Close()

	// A cached token that has already lapsed — the exact state that used to mean a browser.
	if err := Save(tokenExpiringIn(t, -time.Minute), srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := SaveDevice(Device{ID: "dev_abc", Secret: "sec", Hub: srv.URL}); err != nil {
		t.Fatal(err)
	}

	c, err := Resolve(srv.URL)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if c.Token != "fresh-token" {
		t.Fatalf("got %q, want the exchanged token", c.Token)
	}
	// The same scheme the node uses for <nodeId>:<nodeSecret>.
	if authSeen != "Bearer dev_abc:sec" {
		t.Fatalf("presented %q", authSeen)
	}
	// And it was cached, so the next command costs nothing.
	if cached, err := Load(); err != nil || cached.Token != "fresh-token" {
		t.Fatalf("fresh token was not cached: %v %+v", err, cached)
	}
}

func TestResolveKeepsAGoodCachedTokenWithoutExchanging(t *testing.T) {
	withConfigDir(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Resolve exchanged although the cached token was still good")
	}))
	defer srv.Close()

	good := tokenExpiringIn(t, 4*time.Minute)
	if err := Save(good, srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := SaveDevice(Device{ID: "dev_abc", Secret: "sec", Hub: srv.URL}); err != nil {
		t.Fatal(err)
	}

	c, err := Resolve(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if c.Token != good {
		t.Fatalf("got %q, want the cached token", c.Token)
	}
}

// A credential issued by one hub must not be presented to another. Without this, pointing
// $AGENTPOD_HUB at a different host sends this machine's ninety-day secret to a server that
// never issued it.
func TestResolveWillNotSpendACredentialAtAnotherHub(t *testing.T) {
	withConfigDir(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the device credential was presented to a hub that did not issue it")
	}))
	defer srv.Close()

	if err := SaveDevice(Device{ID: "dev_abc", Secret: "sec", Hub: "https://another-hub.test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(srv.URL); err != ErrNoCredential {
		t.Fatalf("want ErrNoCredential, got %v", err)
	}
}

// A refused exchange is "not signed in", not a crash, and the message the caller prints names
// `fleet login` — which is the correct next move whether the device was revoked or expired.
func TestResolveTreatsARefusedExchangeAsNoCredential(t *testing.T) {
	withConfigDir(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"invalid device credential"}`))
	}))
	defer srv.Close()

	if err := SaveDevice(Device{ID: "dev_revoked", Secret: "sec", Hub: srv.URL}); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(srv.URL); err != ErrNoCredential {
		t.Fatalf("want ErrNoCredential, got %v", err)
	}
}

func TestResolveWithNothingAtAllIsNoCredential(t *testing.T) {
	withConfigDir(t)
	if _, err := Resolve("https://hub.test"); err != ErrNoCredential {
		t.Fatalf("want ErrNoCredential, got %v", err)
	}
}

func TestForgetDeviceIsIdempotent(t *testing.T) {
	withConfigDir(t)
	if err := SaveDevice(Device{ID: "dev_x", Secret: "s"}); err != nil {
		t.Fatal(err)
	}
	if err := ForgetDevice(); err != nil {
		t.Fatal(err)
	}
	if err := ForgetDevice(); err != nil {
		t.Fatalf("second ForgetDevice should be a no-op, got %v", err)
	}
	if _, err := LoadDevice(); err != ErrNoDevice {
		t.Fatalf("want ErrNoDevice after Forget, got %v", err)
	}
}
