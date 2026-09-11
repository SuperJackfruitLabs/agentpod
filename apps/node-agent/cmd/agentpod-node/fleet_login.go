package main

// `apn fleet login` — authorization code with PKCE, against the door agentpod#406 built.
//
// No new credential type and no new issuer. The CLI is an OAuth **public client**: it holds no
// secret, which is why PKCE exists at all — the verifier proves the client redeeming the code is
// the one that asked for it.
//
// The flow, and why each step is where it is:
//
//  1. bind a listener on 127.0.0.1 FIRST, so the redirect URI names a port that is already
//     accepting. Asking for a port after sending the browser is a race the browser wins.
//  2. open the browser to the hub's authorize endpoint. A top-level NAVIGATION is the point:
//     the hub's session cookie is SameSite=Lax, which blocks a cross-site fetch and permits
//     this. That asymmetry is the whole reason the flow exists.
//  3. the hub redirects back with a one-time code.
//  4. exchange code + verifier for a token, over HTTP from this process — never in the browser,
//     so the token never enters a URL, history, or a Referer.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcred"
)

// clientID is this CLI's entry in the hub's registry. A hub that has not opted in refuses every
// authorize, which is the correct posture for a deployment that never asked for this door.
const clientID = "apn"

// loginTimeout bounds the wait for a human. Generous: it may include signing in.
const loginTimeout = 5 * time.Minute

func randomURLSafe(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

type loginResult struct {
	code  string
	state string
	err   error
}

func fleetLogin(args []string) {
	if helpRequested(args) {
		fmt.Println(commandHelp("fleet"))
		return
	}
	hub := hubBase()

	// 1. Listen first. The redirect URI has to name a port that is already accepting.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not open a local listener: %v\n", err)
		os.Exit(1)
	}
	defer ln.Close()
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)

	verifier, err := randomURLSafe(48)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	state, err := randomURLSafe(24)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	results := make(chan loginResult, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if e := q.Get("error"); e != "" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprintf(w, "Sign-in refused: %s\n\nYou can close this tab.", e)
			results <- loginResult{err: fmt.Errorf("the hub refused: %s", e)}
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, "Signed in. You can close this tab and return to the terminal.")
		results <- loginResult{code: q.Get("code"), state: q.Get("state")}
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	authorize := hub + "/api/auth/authorize?" + url.Values{
		"client_id":             {clientID},
		"redirect_uri":          {redirectURI},
		"response_type":         {"code"},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}.Encode()

	fmt.Printf("Opening %s\n\nIf a browser does not open, visit:\n  %s\n\n", hub, authorize)
	openBrowser(authorize)

	var got loginResult
	select {
	case got = <-results:
	case <-time.After(loginTimeout):
		fmt.Fprintf(os.Stderr, "Timed out after %s waiting for the browser.\n", loginTimeout)
		os.Exit(1)
	}
	if got.err != nil {
		fmt.Fprintln(os.Stderr, got.err)
		os.Exit(1)
	}
	// Checked before the code is spent. `state` is what ties this callback to the request this
	// process made; without it another page could feed us a code obtained for someone else.
	if got.state != state {
		fmt.Fprintln(os.Stderr, "The callback did not carry the state this login sent. Nothing was exchanged.")
		os.Exit(1)
	}
	if got.code == "" {
		fmt.Fprintln(os.Stderr, "The callback carried no code.")
		os.Exit(1)
	}

	token, err := exchange(hub, got.code, verifier, redirectURI)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := fleetcred.Save(token, hub); err != nil {
		fmt.Fprintf(os.Stderr, "signed in, but could not store the token: %v\n", err)
		os.Exit(1)
	}

	claims, _ := fleetcred.Inspect(token)
	fmt.Printf("Signed in as %s", claims.Subject)
	if claims.PrincipalKind != "" {
		fmt.Printf(" (%s)", claims.PrincipalKind)
	}
	fmt.Printf("\nToken stored at %s\n", fleetcred.Path())
}

// exchange trades the code and verifier for a token, from this process rather than the browser.
func exchange(hub, code, verifier, redirectURI string) (string, error) {
	body, err := json.Marshal(map[string]string{
		"code":          code,
		"code_verifier": verifier,
		"redirect_uri":  redirectURI,
		"client_id":     clientID,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest("POST", hub+"/api/auth/token/exchange", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	// Deliberately no Origin header: the exchange refuses any request carrying one, because a
	// browser that can reach it is a browser that can spend somebody's code.
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach %s: %w", hub, err)
	}
	defer res.Body.Close()
	var out struct {
		Token            string `json:"token"`
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("the hub's answer was not JSON (%d)", res.StatusCode)
	}
	if res.StatusCode != 200 {
		if out.ErrorDescription != "" {
			return "", fmt.Errorf("the hub refused the exchange: %s", out.ErrorDescription)
		}
		return "", fmt.Errorf("the hub refused the exchange (%d): %s", res.StatusCode, out.Error)
	}
	token := out.Token
	if token == "" {
		token = out.AccessToken
	}
	if token == "" {
		return "", fmt.Errorf("the hub returned no token")
	}
	return token, nil
}

// openBrowser is best effort. A failure is not fatal: the URL was printed above, and a headless
// host is a normal place to run this.
func openBrowser(u string) {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "windows":
		cmd, args = "rundll32", []string{"url.dll,FileProtocolHandler"}
	default:
		cmd = "xdg-open"
	}
	_ = exec.Command(cmd, append(args, u)...).Start()
}
