package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeHub stands in for the hub's authorize + exchange pair.
//
// It asserts the things the CLI is responsible for getting right, because those are invisible
// from the CLI's own output: that the redirect is loopback, that PKCE is S256 and the verifier
// really hashes to the challenge, and that the exchange carries no Origin.
type fakeHub struct {
	t         *testing.T
	challenge string
	state     string
	redirect  string
	sawOrigin bool
	issued    string
	exchanges int
	failExchg bool
}

func newFakeHub(t *testing.T, issued string) (*httptest.Server, *fakeHub) {
	h := &fakeHub{t: t, issued: issued}
	mux := http.NewServeMux()

	mux.HandleFunc("/api/auth/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		h.challenge = q.Get("code_challenge")
		h.state = q.Get("state")
		h.redirect = q.Get("redirect_uri")

		if q.Get("code_challenge_method") != "S256" {
			h.t.Errorf("PKCE method = %q, want S256", q.Get("code_challenge_method"))
		}
		if q.Get("client_id") != "apn" {
			h.t.Errorf("client_id = %q", q.Get("client_id"))
		}
		u, err := url.Parse(h.redirect)
		if err != nil || u.Hostname() != "127.0.0.1" || u.Path != "/callback" {
			h.t.Errorf("redirect_uri must be a loopback /callback, got %q", h.redirect)
		}

		back, _ := url.Parse(h.redirect)
		qq := back.Query()
		qq.Set("code", "one-time-code")
		qq.Set("state", h.state)
		back.RawQuery = qq.Encode()
		http.Redirect(w, r, back.String(), http.StatusFound)
	})

	mux.HandleFunc("/api/auth/token/exchange", func(w http.ResponseWriter, r *http.Request) {
		h.exchanges++
		if r.Header.Get("Origin") != "" {
			h.sawOrigin = true
		}
		var body struct {
			Code        string `json:"code"`
			Verifier    string `json:"code_verifier"`
			RedirectURI string `json:"redirect_uri"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		// The verifier must actually hash to the challenge. A CLI that sent a fresh random
		// string here would still "work" against a lax server, and be broken against a real one.
		sum := sha256.Sum256([]byte(body.Verifier))
		if got := base64.RawURLEncoding.EncodeToString(sum[:]); got != h.challenge {
			h.t.Errorf("verifier does not hash to the challenge:\n got %s\nwant %s", got, h.challenge)
		}
		if body.RedirectURI != h.redirect {
			h.t.Errorf("exchange redirect_uri = %q, want %q", body.RedirectURI, h.redirect)
		}
		if h.failExchg {
			w.WriteHeader(400)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error": "invalid_grant", "error_description": "that code was already spent",
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"token": h.issued})
	})

	return httptest.NewServer(mux), h
}

// jwtish builds a token whose payload `whoami` can read.
func jwtish(sub, kind string) string {
	p, _ := json.Marshal(map[string]string{"sub": sub, "principalKind": kind})
	return "aGRy." + base64.RawURLEncoding.EncodeToString(p) + ".c2ln"
}

// runLogin runs `apn fleet …` and, for `login`, PLAYS THE BROWSER ITSELF.
//
// The first version of this test set `BROWSER=true` and trusted the platform to open a browser
// that would follow the redirect. That passes on a developer's Mac, where `open` really works,
// and hangs for five minutes in CI, where nothing opens anything — the fake hub's authorize
// endpoint was simply never called. A test whose result depends on a desktop being present is
// not testing the thing it claims to.
//
// So: `BROWSER=none` stops the CLI opening anything, the test scrapes the authorize URL the CLI
// prints, and fetches it with a client that follows redirects — which is exactly what a browser
// contributes to this flow and nothing more.
func runLogin(t *testing.T, bin, hub, home string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(bin, append([]string{"fleet"}, args...)...)
	cmd.Env = []string{
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + home,
		"PATH=" + os.Getenv("PATH"),
		"AGENTPOD_HUB=" + hub,
		"BROWSER=none",
		// Short, so a broken flow fails in seconds instead of stalling the package for five
		// minutes and then panicking the whole binary on the 10-minute deadline.
		"AGENTPOD_LOGIN_TIMEOUT=20s",
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	// Read as it comes, so the authorize URL can be acted on while the CLI is still waiting.
	var buf strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := sc.Text()
			buf.WriteString(line + "\n")
			if u := strings.TrimSpace(line); strings.Contains(u, "/api/auth/authorize?") {
				go visitAsBrowser(u)
			}
		}
	}()

	<-done
	err = cmd.Wait()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	return buf.String(), code
}

// visitAsBrowser is the only thing a browser does for this flow: GET the URL and follow the
// redirect back to the loopback listener.
func visitAsBrowser(u string) {
	res, err := (&http.Client{Timeout: 15 * time.Second}).Get(u)
	if err == nil {
		_ = res.Body.Close()
	}
}

func TestLoginStoresATokenAndWhoamiReadsIt(t *testing.T) {
	bin := build(t)
	home := t.TempDir()
	srv, hub := newFakeHub(t, jwtish("prn_login", "human"))
	defer srv.Close()

	out, code := runLogin(t, bin, srv.URL, home, "login")
	if code != 0 {
		t.Fatalf("login failed (%d):\n%s", code, out)
	}
	if !strings.Contains(out, "prn_login") {
		t.Errorf("login should report who signed in:\n%s", out)
	}

	// The exchange must have happened from the CLI, without an Origin header — the hub refuses
	// any request carrying one, because a browser that can reach it can spend somebody's code.
	if hub.exchanges != 1 {
		t.Errorf("exchanges = %d, want 1", hub.exchanges)
	}
	if hub.sawOrigin {
		t.Error("the exchange must not send an Origin header")
	}

	// Stored, and only readable by the owner.
	tokenPath := filepath.Join(home, ".config", "agentpod", "token.json")
	if _, err := os.Stat(tokenPath); err != nil {
		// macOS resolves elsewhere; fall back to finding it.
		matches, _ := filepath.Glob(filepath.Join(home, "**", "agentpod", "token.json"))
		if len(matches) == 0 {
			t.Skip("could not locate the token file on this platform layout")
		}
		tokenPath = matches[0]
	}
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("token file mode = %o, want 600", perm)
	}

	// And the credential is usable by the next command, which is the real acceptance test.
	who, code := runLogin(t, bin, srv.URL, home, "whoami")
	if code != 0 || !strings.Contains(who, "prn_login") {
		t.Fatalf("whoami after login (%d):\n%s", code, who)
	}
}

func TestLoginReportsARefusedExchangeWithoutStoringAnything(t *testing.T) {
	bin := build(t)
	home := t.TempDir()
	srv, hub := newFakeHub(t, jwtish("prn_x", "human"))
	hub.failExchg = true
	defer srv.Close()

	out, code := runLogin(t, bin, srv.URL, home, "login")
	if code == 0 {
		t.Fatal("a refused exchange must not succeed")
	}
	if !strings.Contains(out, "already spent") {
		t.Errorf("the hub's own reason should reach the operator:\n%s", out)
	}
	// Nothing stored: a failed login must leave the previous state alone.
	who, whoCode := runLogin(t, bin, srv.URL, home, "whoami")
	if whoCode == 0 {
		t.Fatalf("whoami should still be unauthenticated:\n%s", who)
	}
}

func TestLogoutForgetsTheToken(t *testing.T) {
	bin := build(t)
	home := t.TempDir()
	srv, _ := newFakeHub(t, jwtish("prn_bye", "human"))
	defer srv.Close()

	if _, code := runLogin(t, bin, srv.URL, home, "login"); code != 0 {
		t.Fatal("setup login failed")
	}
	if out, code := runLogin(t, bin, srv.URL, home, "logout"); code != 0 {
		t.Fatalf("logout failed:\n%s", out)
	}
	if _, code := runLogin(t, bin, srv.URL, home, "whoami"); code == 0 {
		t.Fatal("whoami should fail after logout")
	}
}
