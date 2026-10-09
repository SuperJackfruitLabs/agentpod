package mcpproxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const tokenA = "eyJhbGciOi.station-a-token.sig"

type fakeTokens struct {
	mu    sync.Mutex
	calls []string
	next  func(station string) (string, error)
}

func (f *fakeTokens) Token(_ context.Context, station string) (string, error) {
	f.mu.Lock()
	f.calls = append(f.calls, station)
	f.mu.Unlock()
	if f.next != nil {
		return f.next(station)
	}
	return tokenA, nil
}

type logSink struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logSink) Logf(format string, args ...any) {
	l.mu.Lock()
	fmt.Fprintf(&l.buf, format+"\n", args...)
	l.mu.Unlock()
}
func (l *logSink) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.buf.String() }

type upstreamSeen struct {
	mu      sync.Mutex
	auth    []string
	headers []http.Header
	paths   []string
}

func (u *upstreamSeen) record(r *http.Request) {
	u.mu.Lock()
	u.auth = append(u.auth, r.Header.Get("Authorization"))
	u.headers = append(u.headers, r.Header.Clone())
	u.paths = append(u.paths, r.URL.RequestURI())
	u.mu.Unlock()
}
func (u *upstreamSeen) count() int { u.mu.Lock(); defer u.mu.Unlock(); return len(u.auth) }

// start runs a proxy for stations a and b over two fake upstreams.
func start(t *testing.T, tokens TokenSource) (*Proxy, *upstreamSeen, *upstreamSeen, *logSink) {
	t.Helper()
	hubSeen, libSeen := &upstreamSeen{}, &upstreamSeen{}
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hubSeen.record(r)
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"from":"hub"}}`))
	}))
	lib := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		libSeen.record(r)
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"from":"superlibrary"}}`))
	}))
	t.Cleanup(hub.Close)
	t.Cleanup(lib.Close)
	logs := &logSink{}
	if tokens == nil {
		tokens = &fakeTokens{}
	}
	p, err := Start(Config{
		Stations:        []string{"station_a", "station_b"},
		HubURL:          hub.URL + "/mcp",
		SuperlibraryURL: lib.URL + "/mcp",
		Tokens:          tokens,
		Logf:            logs.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return p, hubSeen, libSeen, logs
}

func post(t *testing.T, url, secret string, extra map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set(SecretHeader, secret)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func serverFor(t *testing.T, p *Proxy, station, name string) Server {
	t.Helper()
	for _, s := range p.Servers(station) {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("no %s server for %s", name, station)
	return Server{}
}

func secretOf(s Server) string {
	for _, h := range s.Headers {
		if h.Name == SecretHeader {
			return h.Value
		}
	}
	return ""
}

func TestListenRefusesAnythingButLoopback(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", ":0", "[::]:0", "localhost:0", "10.0.0.1:0"} {
		if ln, err := listenLoopback(addr); err == nil {
			ln.Close()
			t.Errorf("listenLoopback(%q) succeeded; the proxy must bind a loopback IP only", addr)
		}
	}
}

func TestTheProxyBindsLoopbackOnly(t *testing.T) {
	p, _, _, _ := start(t, nil)
	host, _, err := net.SplitHostPort(p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		t.Fatalf("bound %s, want a loopback address", p.Addr())
	}
	for _, s := range p.Servers("station_a") {
		if !strings.HasPrefix(s.URL, "http://127.0.0.1:") {
			t.Fatalf("server url %q is not loopback", s.URL)
		}
	}
}

func TestAMissingOrWrongSecretIsRefusedAndLoggedWithoutIt(t *testing.T) {
	p, hubSeen, _, logs := start(t, nil)
	hub := serverFor(t, p, "station_a", "agentpod")
	for name, secret := range map[string]string{"missing": "", "wrong": "not-the-secret"} {
		res := post(t, hub.URL, secret, nil)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s secret: status %d, want 401", name, res.StatusCode)
		}
	}
	if hubSeen.count() != 0 {
		t.Fatal("a refused request reached the upstream")
	}
	out := logs.String()
	if !strings.Contains(out, "station_a") || !strings.Contains(out, "refused") {
		t.Fatalf("refusals not logged: %q", out)
	}
	if strings.Contains(out, secretOf(hub)) || strings.Contains(out, "not-the-secret") {
		t.Fatal("a secret reached the log")
	}
}

func TestOneStationsSecretCannotReachAnother(t *testing.T) {
	p, hubSeen, libSeen, _ := start(t, nil)
	secretA := secretOf(serverFor(t, p, "station_a", "agentpod"))
	for _, name := range []string{"agentpod", "superlibrary"} {
		res := post(t, serverFor(t, p, "station_b", name).URL, secretA, nil)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: station A's secret on B's path got %d", name, res.StatusCode)
		}
	}
	if secretA == secretOf(serverFor(t, p, "station_b", "agentpod")) {
		t.Fatal("two stations share a secret")
	}
	if hubSeen.count()+libSeen.count() != 0 {
		t.Fatal("a cross-station request reached an upstream")
	}
}

func TestAStationTheOperatorDidNotNameHasNoServersAndNoPath(t *testing.T) {
	p, _, _, _ := start(t, nil)
	if got := p.Servers("station_z"); len(got) != 0 {
		t.Fatalf("unnamed station got servers: %v", got)
	}
	secretA := secretOf(serverFor(t, p, "station_a", "agentpod"))
	res := post(t, "http://"+p.Addr()+"/stations/station_z/mcp/hub", secretA, nil)
	if res.StatusCode == http.StatusOK {
		t.Fatal("an unnamed station's path was served")
	}
	res = post(t, "http://"+p.Addr()+"/stations/station_a/mcp/elsewhere", secretA, nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown upstream: status %d, want 404", res.StatusCode)
	}
}

func TestForwardsWithTheStationsTokenAndNeverTheSecret(t *testing.T) {
	tokens := &fakeTokens{}
	p, hubSeen, libSeen, logs := start(t, tokens)
	hub := serverFor(t, p, "station_a", "agentpod")
	res := post(t, hub.URL+"?x=1", secretOf(hub), map[string]string{
		"Authorization":  "Bearer caller-supplied",
		"Mcp-Session-Id": "mcps_1",
	})
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(body), `"hub"`) {
		t.Fatalf("status %d body %s", res.StatusCode, body)
	}
	if hubSeen.auth[0] != "Bearer "+tokenA {
		t.Fatalf("upstream saw Authorization %q", hubSeen.auth[0])
	}
	h := hubSeen.headers[0]
	if h.Get(SecretHeader) != "" {
		t.Fatal("the proxy secret was forwarded upstream")
	}
	if h.Get("Mcp-Session-Id") != "mcps_1" {
		t.Fatal("the MCP session header was not forwarded")
	}
	if hubSeen.paths[0] != "/mcp?x=1" {
		t.Fatalf("upstream path %q", hubSeen.paths[0])
	}
	if strings.Contains(string(body), tokenA) {
		t.Fatal("the token reached the caller")
	}
	for k, vs := range res.Header {
		for _, v := range vs {
			if strings.Contains(v, tokenA) {
				t.Fatalf("the token reached the caller in %s", k)
			}
		}
	}
	if strings.Contains(logs.String(), tokenA) {
		t.Fatal("the token reached the log")
	}
	if tokens.calls[0] != "station_a" {
		t.Fatalf("minted for %v", tokens.calls)
	}

	lib := serverFor(t, p, "station_a", "superlibrary")
	res = post(t, lib.URL, secretOf(lib), nil)
	body, _ = io.ReadAll(res.Body)
	if !strings.Contains(string(body), `"superlibrary"`) || libSeen.auth[0] != "Bearer "+tokenA {
		t.Fatalf("superlibrary: %s / %v", body, libSeen.auth)
	}
}

func TestEveryRequestAsksForACurrentToken(t *testing.T) {
	// The proxy holds no token of its own: each request asks the source, which refreshes before
	// expiry (stationtoken.Source). So a session longer than one token's life keeps working.
	var n atomic.Int32
	tokens := &fakeTokens{next: func(string) (string, error) { return fmt.Sprintf("tok-%d", n.Add(1)), nil }}
	p, hubSeen, _, _ := start(t, tokens)
	hub := serverFor(t, p, "station_a", "agentpod")
	post(t, hub.URL, secretOf(hub), nil)
	post(t, hub.URL, secretOf(hub), nil)
	if hubSeen.auth[0] != "Bearer tok-1" || hubSeen.auth[1] != "Bearer tok-2" {
		t.Fatalf("upstream saw %v", hubSeen.auth)
	}
}

func TestAMintFailureIsA502ThatLeaksNothing(t *testing.T) {
	tokens := &fakeTokens{next: func(string) (string, error) { return "", errors.New("hub answered 409") }}
	p, hubSeen, _, logs := start(t, tokens)
	hub := serverFor(t, p, "station_a", "agentpod")
	res := post(t, hub.URL, secretOf(hub), nil)
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d", res.StatusCode)
	}
	if hubSeen.count() != 0 {
		t.Fatal("forwarded without a token")
	}
	if strings.Contains(string(body), secretOf(hub)) || strings.Contains(logs.String(), secretOf(hub)) {
		t.Fatal("the secret leaked on a mint failure")
	}
	if !strings.Contains(logs.String(), "409") {
		t.Fatalf("the hub's reason was not logged: %q", logs.String())
	}
}

func TestStreamsAnSSEResponseAsItArrives(t *testing.T) {
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "event: message\ndata: {\"first\":true}\n\n")
		w.(http.Flusher).Flush()
		<-release
		fmt.Fprint(w, "event: message\ndata: {\"second\":true}\n\n")
	}))
	defer up.Close()
	defer close(release)
	p, err := Start(Config{Stations: []string{"station_a"}, HubURL: up.URL + "/mcp", SuperlibraryURL: up.URL + "/mcp", Tokens: &fakeTokens{}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	hub := serverFor(t, p, "station_a", "agentpod")
	res := post(t, hub.URL, secretOf(hub), map[string]string{"Accept": "text/event-stream"})
	got := make(chan string, 1)
	go func() {
		r := bufio.NewReader(res.Body)
		for {
			line, err := r.ReadString('\n')
			if strings.Contains(line, "first") {
				got <- line
				return
			}
			if err != nil {
				got <- "EOF before the first event"
				return
			}
		}
	}()
	select {
	case line := <-got:
		if !strings.Contains(line, "first") {
			t.Fatal(line)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the first event was held until the stream ended: the proxy buffers")
	}
}

func TestSecretsRotateWithEachStart(t *testing.T) {
	p1, _, _, _ := start(t, nil)
	p2, _, _, _ := start(t, nil)
	a1, a2 := secretOf(serverFor(t, p1, "station_a", "agentpod")), secretOf(serverFor(t, p2, "station_a", "agentpod"))
	if a1 == "" || a1 == a2 {
		t.Fatal("a restarted proxy reused its secret")
	}
	if len(a1) < 32 {
		t.Fatalf("secret %d chars; want at least 32 (128 bits hex)", len(a1))
	}
}

func TestOnlyHarnessesThatTakeHTTPMCPServersQualify(t *testing.T) {
	for h, want := range map[string]bool{
		"hermes": true, "claude-code": true, "codex": true, "opencode": true,
		"openclaw": false, "pi": false, "": false, "unknown": false,
	} {
		if got := SupportsHTTP(h); got != want {
			t.Errorf("SupportsHTTP(%q) = %v, want %v", h, got, want)
		}
	}
}

func TestInjectAddsTheServersToSessionNew(t *testing.T) {
	servers := []Server{{Type: "http", Name: "agentpod", URL: "http://127.0.0.1:1/stations/s/mcp/hub", Headers: []Header{{Name: SecretHeader, Value: "k"}}}}
	in := []byte(`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/w","mcpServers":[{"type":"http","name":"superpipeline","url":"https://x","headers":[]}]}}` + "\n")
	out := Inject(in, servers)
	if !bytes.HasSuffix(out, []byte("\n")) {
		t.Fatal("newline framing lost")
	}
	var msg struct {
		ID     int    `json:"id"`
		Method string `json:"method"`
		Params struct {
			Cwd        string   `json:"cwd"`
			MCPServers []Server `json:"mcpServers"`
		} `json:"params"`
	}
	if err := json.Unmarshal(out, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.ID != 2 || msg.Params.Cwd != "/w" || len(msg.Params.MCPServers) != 2 {
		t.Fatalf("got %s", out)
	}
	if msg.Params.MCPServers[0].Name != "superpipeline" || msg.Params.MCPServers[1].Name != "agentpod" {
		t.Fatalf("order/names: %+v", msg.Params.MCPServers)
	}
	// session/load and session/resume carry mcpServers too.
	for _, m := range []string{"session/load", "session/resume"} {
		in := []byte(`{"jsonrpc":"2.0","id":3,"method":"` + m + `","params":{"sessionId":"x","cwd":"/w","mcpServers":[]}}` + "\n")
		if !bytes.Contains(Inject(in, servers), []byte(`"agentpod"`)) {
			t.Errorf("%s not injected", m)
		}
	}
	// A server of the same name is replaced, not doubled.
	dup := []byte(`{"jsonrpc":"2.0","id":4,"method":"session/new","params":{"cwd":"/w","mcpServers":[{"type":"http","name":"agentpod","url":"https://elsewhere","headers":[]}]}}` + "\n")
	if got := Inject(dup, servers); bytes.Contains(got, []byte("elsewhere")) || bytes.Count(got, []byte(`"agentpod"`)) != 1 {
		t.Fatalf("duplicate handling: %s", got)
	}
}

func TestInjectLeavesEverythingElseByteForByte(t *testing.T) {
	servers := []Server{{Type: "http", Name: "agentpod", URL: "http://127.0.0.1:1/x"}}
	for name, in := range map[string][]byte{
		"prompt":   []byte(`{"jsonrpc":"2.0","id":5,"method":"session/prompt","params":{"sessionId":"s","prompt":[]}}` + "\n"),
		"response": []byte(`{"jsonrpc":"2.0","id":1,"result":{"mcpServers":[]}}` + "\n"),
		"not json": []byte("hello\n"),
		"partial":  []byte(`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{`),
	} {
		if out := Inject(in, servers); !bytes.Equal(out, in) {
			t.Errorf("%s changed:\n%s\n%s", name, in, out)
		}
	}
	if out := Inject([]byte("x\n"), nil); string(out) != "x\n" {
		t.Fatal("no servers must be a no-op")
	}
}

func TestAHarnessWithoutHTTPMCPSupportGetsNoServers(t *testing.T) {
	p, _, _, _ := start(t, nil)
	for _, h := range []string{"openclaw", "pi", ""} {
		if got := p.ServersForHarness("station_a", h); len(got) != 0 {
			t.Errorf("%q got %d servers", h, len(got))
		}
	}
	for _, h := range []string{"hermes", "claude-code", "codex", "opencode"} {
		if got := p.ServersForHarness("station_a", h); len(got) != 2 {
			t.Errorf("%q got %d servers, want 2", h, len(got))
		}
	}
	if got := p.ServersForHarness("station_z", "hermes"); len(got) != 0 {
		t.Error("an unnamed station got servers")
	}
}
