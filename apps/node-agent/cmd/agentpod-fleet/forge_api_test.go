package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/nacl/box"
)

// A fake hub for `fleet stations forge-api`: records every request in order, answers the key
// route with a test keypair's public half, and answers everything else with a fixed grant view.
type forgeHub struct {
	t       *testing.T
	pub     *[32]byte
	priv    *[32]byte
	mu      sync.Mutex
	calls   []forgeCall
	status  map[string]int // "METHOD /path" → status to answer with instead
	listRaw string
}

type forgeCall struct {
	Method, Path, Body string
}

const fakeGrantView = `{"grant":{"id":"fag_1","stationId":"stn_1","provider":"github","instance":"https://github.com",` +
	`"mode":"supplied","account":"octo-bot","expectedLogin":"octo-bot","repositories":["org/repo"],"preset":"issues",` +
	`"rules":[],"allowGraphql":false,"state":"provisioned","stateReason":null,"generation":1,"isolation":null,` +
	`"hasPendingCredential":false,"rotation":null}}`

func newForgeHub(t *testing.T) (*forgeHub, *httptest.Server) {
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h := &forgeHub{t: t, pub: pub, priv: priv, status: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		h.mu.Lock()
		h.calls = append(h.calls, forgeCall{r.Method, r.URL.Path, string(b)})
		code := h.status[r.Method+" "+r.URL.Path]
		listRaw := h.listRaw
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if code != 0 {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"error":"refused","message":"Refused for the test."}`))
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/forge-api/key"):
			_, _ = w.Write([]byte(`{"publicKey":"stk-handover-v1:` + base64.RawURLEncoding.EncodeToString(pub[:]) + `"}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/forge-api"):
			_, _ = w.Write([]byte(listRaw))
		default:
			_, _ = w.Write([]byte(fakeGrantView))
		}
	}))
	t.Cleanup(srv.Close)
	return h, srv
}

func (h *forgeHub) setList(raw string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.listRaw = raw
}

// open decrypts a posted envelope with the test keypair.
func (h *forgeHub) open(envelope string) map[string]string {
	h.t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(envelope, "stk-handover-v1:"))
	if err != nil {
		h.t.Fatalf("envelope is not base64url: %v", err)
	}
	plain, ok := box.OpenAnonymous(nil, raw, h.pub, h.priv)
	if !ok {
		h.t.Fatal("the envelope does not open with the station's key")
	}
	var m map[string]string
	if err := json.Unmarshal(plain, &m); err != nil {
		h.t.Fatal(err)
	}
	return m
}

func runStdin(t *testing.T, bin, hub, stdin string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	home := t.TempDir()
	cmd.Env = []string{
		"HOME=" + home, "XDG_CONFIG_HOME=" + home, "PATH=" + os.Getenv("PATH"),
		"AGENTPOD_HUB=" + hub, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human"),
	}
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return string(out), code
}

const testPAT = "ghp_THIS1is2a3TEST4token5NOT6real7AAAAAAAA"

var suppliedGrant = []string{"stations", "forge-api", "grant", "--station", "stn_1", "--provider", "github",
	"--instance", "https://github.com", "--repo", "org/repo", "--preset", "issues", "--mode", "supplied",
	"--expect-login", "octo-bot"}

// The supplied token is read from stdin, sealed to the station's key on this machine, and only
// the envelope travels: the grant body carries no credential, the secret body is exactly
// {sealed}, and the envelope opens (with the station's private key) to the token.
func TestForgeAPISuppliedSealsStdinAndSendsOnlyAnEnvelope(t *testing.T) {
	bin := build(t)
	h, srv := newForgeHub(t)
	out, code := runStdin(t, bin, srv.URL, testPAT+"\n", suppliedGrant...)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if strings.Contains(out, testPAT) {
		t.Fatalf("the token was echoed: %s", out)
	}
	var paths []string
	for _, c := range h.calls {
		paths = append(paths, c.Method+" "+c.Path)
		if strings.Contains(c.Body, testPAT) || strings.Contains(c.Path, testPAT) {
			t.Fatalf("plaintext token in a request: %s %s %s", c.Method, c.Path, c.Body)
		}
	}
	want := []string{
		"GET /api/stations/stn_1/forge-api/key",
		"POST /api/stations/stn_1/forge-api",
		"POST /api/stations/stn_1/forge-api/fag_1/secret",
	}
	if strings.Join(paths, "|") != strings.Join(want, "|") {
		t.Fatalf("calls = %v, want %v (the key once, first; the secret last)", paths, want)
	}
	var grant map[string]any
	if err := json.Unmarshal([]byte(h.calls[1].Body), &grant); err != nil {
		t.Fatal(err)
	}
	if grant["expectedLogin"] != "octo-bot" || grant["mode"] != "supplied" {
		t.Errorf("grant body = %v", grant)
	}
	for _, k := range []string{"token", "secret", "sealed", "account"} {
		if _, ok := grant[k]; ok {
			t.Errorf("grant body carries %q: %v", k, grant)
		}
	}
	var secret map[string]any
	if err := json.Unmarshal([]byte(h.calls[2].Body), &secret); err != nil {
		t.Fatal(err)
	}
	if len(secret) != 1 {
		t.Fatalf("secret body has more than {sealed}: %v", secret)
	}
	env, _ := secret["sealed"].(string)
	if got := h.open(env); len(got) != 1 || got["token"] != testPAT {
		t.Fatalf("envelope opened to %v, want {token: the stdin token}", got)
	}
}

// An app grant reads the App's three fields from stdin, the PEM key over several lines.
func TestForgeAPIAppSealsTheThreeFields(t *testing.T) {
	bin := build(t)
	h, srv := newForgeHub(t)
	pem := "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----"
	stdin := "app_id=12345\ninstallation_id=67890\nprivate_key=" + pem + "\n"
	args := []string{"stations", "forge-api", "grant", "--station", "stn_1", "--provider", "github",
		"--instance", "https://github.com", "--repo", "org/repo", "--mode", "app", "--expect-login", "my-app"}
	out, code := runStdin(t, bin, srv.URL, stdin, args...)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if len(h.calls) != 3 {
		t.Fatalf("calls = %v", h.calls)
	}
	for _, c := range h.calls {
		if strings.Contains(c.Body, "MIIBOg") {
			t.Fatalf("plaintext key in a request body: %s", c.Body)
		}
	}
	var secret map[string]string
	_ = json.Unmarshal([]byte(h.calls[2].Body), &secret)
	got := h.open(secret["sealed"])
	if got["app_id"] != "12345" || got["installation_id"] != "67890" || got["private_key"] != pem || len(got) != 3 {
		t.Fatalf("envelope opened to %v", got)
	}
}

// A minted grant needs no credential: no key fetch, no secret, nothing read from stdin.
func TestForgeAPIMintedGrantIsOneCall(t *testing.T) {
	bin := build(t)
	h, srv := newForgeHub(t)
	out, code := runStdin(t, bin, srv.URL, "", "stations", "forge-api", "grant", "--station", "stn_1",
		"--provider", "forgejo", "--instance", "https://forge.example", "--repo", "org/repo",
		"--rule", "allow: POST /repos/org/repo/issues/*/comments", "--rule", "deny: DELETE /repos/**")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if len(h.calls) != 1 || h.calls[0].Path != "/api/stations/stn_1/forge-api" {
		t.Fatalf("calls = %v", h.calls)
	}
	var b struct {
		Mode   string              `json:"mode"`
		Preset string              `json:"preset"`
		Rules  []map[string]string `json:"rules"`
	}
	_ = json.Unmarshal([]byte(h.calls[0].Body), &b)
	if b.Mode != "minted" || b.Preset != "read" || len(b.Rules) != 2 ||
		b.Rules[0]["allow"] != "POST /repos/org/repo/issues/*/comments" || b.Rules[1]["deny"] != "DELETE /repos/**" {
		t.Fatalf("grant body = %s", h.calls[0].Body)
	}
}

// There is no way to put a credential on the command line: the flag set is exactly this.
func TestForgeAPIHasNoSecretFlag(t *testing.T) {
	f := newForgeAPIFlags()
	var names []string
	f.fs.VisitAll(func(fl *flag.Flag) { names = append(names, fl.Name) })
	sort.Strings(names)
	want := []string{"allow-graphql", "expect-login", "grant", "instance", "json", "mode", "preset", "provider", "repo", "rule", "rules-file", "station"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("flags = %v, want %v", names, want)
	}
	bin := build(t)
	for _, flagName := range []string{"--token", "--secret", "--private-key"} {
		h, srv := newForgeHub(t)
		out, code := runStdin(t, bin, srv.URL, "", append(append([]string{}, suppliedGrant...), flagName, testPAT)...)
		if code == 0 || len(h.calls) != 0 {
			t.Fatalf("%s was accepted (exit %d, %d calls): %s", flagName, code, len(h.calls), out)
		}
		if !strings.Contains(out, "flag provided but not defined") {
			t.Errorf("%s: unexpected refusal: %s", flagName, out)
		}
	}
}

// list shows what an operator needs — state, mode, account, isolation — and never a field it
// does not know, so even a hub that leaked a token would not get it printed.
func TestForgeAPIListPrintsNoSecret(t *testing.T) {
	bin := build(t)
	h, srv := newForgeHub(t)
	h.setList(`{"grants":[{"id":"fag_1","provider":"forgejo","instance":"https://forge.example","mode":"minted",` +
		`"account":"chotu","repositories":["org/repo"],"preset":"issues","state":"verified","isolation":"separate-user",` +
		`"token":"` + testPAT + `","sealedBlob":"stk-handover-v1:AAAA","tokenHandle":{"name":"agentpod-x"}}]}`)
	out, code := runStdin(t, bin, srv.URL, "", "stations", "forge-api", "list", "--station", "stn_1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	for _, want := range []string{"fag_1", "verified", "minted", "chotu", "separate-user", "org/repo"} {
		if !strings.Contains(out, want) {
			t.Errorf("list lacks %q: %s", want, out)
		}
	}
	for _, bad := range []string{testPAT, "stk-handover-v1", "agentpod-x"} {
		if strings.Contains(out, bad) {
			t.Errorf("list printed %q: %s", bad, out)
		}
	}
}

// Refused before any request: each mistake is caught on this machine.
func TestForgeAPIClientSideRefusals(t *testing.T) {
	bin := build(t)
	base := func(over ...string) []string {
		return append([]string{"stations", "forge-api", "grant", "--station", "stn_1", "--provider", "forgejo",
			"--instance", "https://forge.example"}, over...)
	}
	for name, tc := range map[string]struct {
		args  []string
		stdin string
		says  string
	}{
		"no repo":            {base(), "", "--repo"},
		"http instance":      {[]string{"stations", "forge-api", "grant", "--station", "stn_1", "--provider", "forgejo", "--instance", "http://forge.example", "--repo", "o/r"}, "", "https"},
		"unknown preset":     {base("--repo", "o/r", "--preset", "admin"), "", "preset"},
		"unknown provider":   {[]string{"stations", "forge-api", "grant", "--station", "stn_1", "--provider", "gitlab", "--instance", "https://x.example", "--repo", "o/r"}, "", "provider"},
		"unknown mode":       {base("--repo", "o/r", "--mode", "pasted"), "", "mode"},
		"supplied, no login": {base("--repo", "o/r", "--mode", "supplied"), testPAT, "--expect-login"},
		"app, no login":      {base("--repo", "o/r", "--mode", "app"), "app_id=1\n", "--expect-login"},
		"bad rule":           {base("--repo", "o/r", "--rule", "permit POST /x"), "", "--rule"},
		"empty stdin":        {base("--repo", "o/r", "--mode", "supplied", "--expect-login", "x"), "", "stdin"},
		"app missing field":  {base("--repo", "o/r", "--mode", "app", "--expect-login", "x"), "app_id=1\nprivate_key=k\n", "installation_id"},
		"no station":         {[]string{"stations", "forge-api", "list"}, "", "--station"},
		"verify, no grant":   {[]string{"stations", "forge-api", "verify", "--station", "stn_1"}, "", "--grant"},
		"policy, no preset":  {[]string{"stations", "forge-api", "policy", "--station", "stn_1", "--grant", "fag_1"}, "", "--preset"},
		"unknown verb":       {[]string{"stations", "forge-api", "wat", "--station", "stn_1"}, "", "forge-api"},
	} {
		t.Run(name, func(t *testing.T) {
			h, srv := newForgeHub(t)
			out, code := runStdin(t, bin, srv.URL, tc.stdin, tc.args...)
			if code == 0 {
				t.Fatalf("accepted: %s", out)
			}
			if len(h.calls) != 0 {
				t.Fatalf("reached the hub: %v", h.calls)
			}
			if !strings.Contains(out, tc.says) {
				t.Errorf("refusal does not mention %q: %s", tc.says, out)
			}
			if tc.stdin != "" && strings.Contains(out, tc.stdin) {
				t.Errorf("the refusal echoed stdin: %s", out)
			}
		})
	}
}

// A refusal from the hub is printed with its status and the hub's own (fixed) message, never the
// request: the secret POST failing must not print the envelope, nor the grant POST the token.
func TestForgeAPIHubErrorsDoNotEchoTheRequest(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		route  string
		status int
	}{
		{"GET /api/stations/stn_1/forge-api/key", http.StatusBadGateway},
		{"POST /api/stations/stn_1/forge-api", http.StatusConflict},
		{"POST /api/stations/stn_1/forge-api/fag_1/secret", http.StatusForbidden},
	} {
		t.Run(tc.route, func(t *testing.T) {
			h, srv := newForgeHub(t)
			h.mu.Lock()
			h.status[tc.route] = tc.status
			h.mu.Unlock()
			out, code := runStdin(t, bin, srv.URL, testPAT, suppliedGrant...)
			if code == 0 {
				t.Fatalf("exit 0: %s", out)
			}
			if !strings.Contains(out, "Refused for the test.") {
				t.Errorf("the hub's message is missing: %s", out)
			}
			if strings.Contains(out, testPAT) || strings.Contains(out, "stk-handover-v1:") || strings.Contains(out, "expectedLogin") {
				t.Errorf("the request leaked into the error: %s", out)
			}
			if tc.status == http.StatusBadGateway && len(h.calls) != 1 {
				t.Errorf("a grant was created although the key could not be fetched: %v", h.calls)
			}
			if tc.status == http.StatusForbidden && !strings.Contains(out, "fag_1") {
				t.Errorf("a failed secret step does not name the grant to re-supply to: %s", out)
			}
		})
	}
}

// Every lifecycle verb reaches its route with an empty or policy body.
func TestForgeAPILifecycleVerbsReachTheirRoutes(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		args   []string
		method string
		path   string
		stdin  string
	}{
		{[]string{"verify"}, "POST", "/api/stations/stn_1/forge-api/fag_1/verify", ""},
		{[]string{"rotate"}, "POST", "/api/stations/stn_1/forge-api/fag_1/rotate", ""},
		{[]string{"revoke"}, "DELETE", "/api/stations/stn_1/forge-api/fag_1", ""},
		{[]string{"confirm-revoked"}, "POST", "/api/stations/stn_1/forge-api/fag_1/confirm-revoked", ""},
		{[]string{"policy", "--preset", "issues", "--rule", "allow: POST /x"}, "PATCH", "/api/stations/stn_1/forge-api/fag_1/policy", ""},
	} {
		t.Run(tc.args[0], func(t *testing.T) {
			h, srv := newForgeHub(t)
			args := append([]string{"stations", "forge-api", tc.args[0], "--station", "stn_1", "--grant", "fag_1"}, tc.args[1:]...)
			out, code := runStdin(t, bin, srv.URL, tc.stdin, args...)
			if code != 0 {
				t.Fatalf("exit %d: %s", code, out)
			}
			if len(h.calls) != 1 || h.calls[0].Method != tc.method || h.calls[0].Path != tc.path {
				t.Fatalf("calls = %v", h.calls)
			}
			if tc.args[0] == "policy" {
				if h.calls[0].Body != `{"allowGraphql":false,"preset":"issues","rules":[{"allow":"POST /x"}]}` {
					t.Errorf("policy body = %s", h.calls[0].Body)
				}
			} else if h.calls[0].Body != "{}" {
				t.Errorf("body = %s", h.calls[0].Body)
			}
		})
	}
	// secret: re-supply to an existing grant — key first, then the envelope.
	h, srv := newForgeHub(t)
	out, code := runStdin(t, bin, srv.URL, testPAT, "stations", "forge-api", "secret", "--station", "stn_1", "--grant", "fag_1")
	if code != 0 {
		t.Fatalf("secret: exit %d: %s", code, out)
	}
	if len(h.calls) != 2 || !strings.HasSuffix(h.calls[0].Path, "/forge-api/key") || h.calls[1].Path != "/api/stations/stn_1/forge-api/fag_1/secret" {
		t.Fatalf("secret calls = %v", h.calls)
	}
	var s map[string]string
	_ = json.Unmarshal([]byte(h.calls[1].Body), &s)
	if h.open(s["sealed"])["token"] != testPAT {
		t.Fatal("re-supplied envelope does not open to the token")
	}
}

// Rules with conditions come from a JSON file.
func TestForgeAPIRulesFile(t *testing.T) {
	bin := build(t)
	h, srv := newForgeHub(t)
	p := t.TempDir() + "/rules.json"
	_ = os.WriteFile(p, []byte(`[{"allow":"POST /repos/o/r/pulls","when":{"body.head":"absent"}}]`), 0o600)
	out, code := runStdin(t, bin, srv.URL, "", "stations", "forge-api", "policy", "--station", "stn_1", "--grant", "fag_1",
		"--preset", "read", "--rules-file", p)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if !strings.Contains(h.calls[0].Body, `"when":{"body.head":"absent"}`) {
		t.Fatalf("body = %s", h.calls[0].Body)
	}
}

// The forge-api help text and the reference agree: every verb the usage lists is a reference
// entry, and every reference entry is in the usage.
func TestForgeAPIHelpAndReferenceAgree(t *testing.T) {
	inRef := map[string]bool{}
	for _, c := range reference.Commands {
		if v, ok := strings.CutPrefix(c.Path, "stations forge-api "); ok {
			inRef[v] = true
		}
	}
	inHelp := map[string]bool{}
	for _, line := range strings.Split(forgeAPIUsage, "\n") {
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "   ") {
			inHelp[strings.Fields(line)[0]] = true
		}
	}
	if len(inRef) != 8 || len(inHelp) != len(inRef) {
		t.Fatalf("reference %v, help %v", inRef, inHelp)
	}
	for v := range inRef {
		if !inHelp[v] {
			t.Errorf("%s is in the reference but not the help", v)
		}
	}
	if !strings.Contains(stationsUsage, "forge-api") {
		t.Error("fleet stations --help does not mention forge-api")
	}
}

// The retry hint after a failed secret POST names the mode that reads that credential's shape:
// `secret` defaults to a one-line token, so an app grant's hint must say --mode app.
func TestForgeAPISecretRetryHintNamesTheMode(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct{ mode, stdin string }{
		{"supplied", testPAT},
		{"app", "app_id=1\ninstallation_id=2\nprivate_key=k\n"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			h, srv := newForgeHub(t)
			h.mu.Lock()
			h.status["POST /api/stations/stn_1/forge-api/fag_1/secret"] = http.StatusForbidden
			h.mu.Unlock()
			args := []string{"stations", "forge-api", "grant", "--station", "stn_1", "--provider", "github",
				"--instance", "https://github.com", "--repo", "org/repo", "--mode", tc.mode, "--expect-login", "x"}
			out, code := runStdin(t, bin, srv.URL, tc.stdin, args...)
			if code == 0 || !strings.Contains(out, "forge-api secret --station stn_1 --grant fag_1 --mode "+tc.mode) {
				t.Fatalf("exit %d, hint lacks --mode %s: %s", code, tc.mode, out)
			}
		})
	}
}

func TestEnvelopeGuard(t *testing.T) {
	if err := checkEnvelope("stk-handover-v1:abc"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "abc", "ghp_xxx"} {
		if err := checkEnvelope(bad); err == nil || strings.Contains(err.Error(), bad+"x") {
			t.Errorf("%q accepted or error echoes it: %v", bad, err)
		}
	}
}

// A credential whose sealed envelope the hub would refuse is refused HERE, before a grant exists:
// the hub caps a supplied/app envelope (FORGE_API_SEALED_MAX) far below the 64 KiB stdin limit.
func TestForgeAPIOversizedCredentialRefusedBeforeTheGrant(t *testing.T) {
	bin := build(t)
	h, srv := newForgeHub(t)
	key := strings.Repeat("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n", 600) // ~22 KiB of key lines
	stdin := "app_id=1\ninstallation_id=2\nprivate_key=" + key
	args := []string{"stations", "forge-api", "grant", "--station", "stn_1", "--provider", "github",
		"--instance", "https://github.com", "--repo", "org/repo", "--mode", "app", "--expect-login", "my-app"}
	out, code := runStdin(t, bin, srv.URL, stdin, args...)
	if code == 0 {
		t.Fatalf("an oversized credential was accepted: %s", out)
	}
	if !strings.Contains(out, "16384") {
		t.Errorf("the refusal should name the hub's limit: %s", out)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.calls {
		if c.Method == http.MethodPost {
			t.Fatalf("a grant was created (or a secret sent) for a credential the hub would refuse: %s %s", c.Method, c.Path)
		}
	}
}

// The CLI's envelope cap is the contract's FORGE_API_SEALED_MAX, the one value the hub uses.
func TestForgeSealedMaxMatchesTheContract(t *testing.T) {
	src, err := os.ReadFile("../../../../packages/contract/src/forge-api.ts")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`export const FORGE_API_SEALED_MAX = (\d+);`).FindSubmatch(src)
	if m == nil {
		t.Fatal("packages/contract/src/forge-api.ts does not export FORGE_API_SEALED_MAX as a literal")
	}
	if want := string(m[1]); want != strconv.Itoa(forgeSealedMax) {
		t.Fatalf("forgeSealedMax = %d, contract FORGE_API_SEALED_MAX = %s", forgeSealedMax, want)
	}
}
