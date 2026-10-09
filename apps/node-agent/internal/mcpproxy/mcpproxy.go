// Package mcpproxy is the node's loopback MCP proxy: it lets an agent's harness session reach
// the hub's MCP server and Superlibrary's, as the station's own agent, for as long as the session
// runs — without any credential leaving the node.
//
// **What it is.** An HTTP server bound to a loopback address only. Each station the operator
// named gets two paths, `/stations/<stationId>/mcp/hub` and `/stations/<stationId>/mcp/superlibrary`,
// and an unguessable per-station secret, generated when the proxy starts (so a node restart
// rotates every one). A request must carry its station's secret in `X-Agentpod-Proxy-Key`; any
// other request is refused and logged — with the station and the reason, never the secret.
//
// For an accepted request the proxy asks a TokenSource for that station's current token — the
// same five-minute station token the node already mints through the hub's station-token
// exchange (`POST /api/nodes/:nodeId/stations/:stationId/token`), cached until near expiry and
// minted single-flight — and forwards the request upstream with `Authorization: Bearer <token>`.
// The caller never sees the token: it is set on the outgoing request only, and the response is
// streamed back as the upstream wrote it (SSE included, flushed as it arrives).
//
// **Why this shape (Superlibrary Stage 3, ruling S3-R11, option a).** A station token lives five
// minutes, so handing one to a session at `session/new` fails every claim that runs longer. A
// per-dispatch credential would be a new credential path on the hub. The node already holds the
// only credential this needs and already exchanges it per station; the proxy spends that
// exchange per request, so the agent holds nothing but a loopback URL and a secret that is
// worthless off this machine and dies with this process.
//
// **The token is an AGENT's.** `sub` is the station's principal and `principalKind` is `agent`:
// the hub and Superlibrary see the agent acting as itself, never a person (R-H1).
//
// **Who gets it.** Only a station the operator named (`mcpProxy.stations` in the node config) and
// only a harness that takes HTTP MCP servers in `session/new` (SupportsHTTP). The servers are
// injected into the harness's `session/new` by the node (Inject), on the hub's request
// (`acp.open { mcpProxy }`), and the node tells the hub which it injected — so the card prompt
// names the tools exactly when the session has them.
package mcpproxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// SecretHeader carries a station's proxy secret on each request.
const SecretHeader = "X-Agentpod-Proxy-Key"

// The names the harness gives the servers — it prefixes their tools with them.
const (
	HubServerName          = "agentpod"
	SuperlibraryServerName = "superlibrary"
)

// DefaultSuperlibraryURL is Superlibrary's MCP endpoint when the node config names none.
const DefaultSuperlibraryURL = "https://app.superlibrary.dev/mcp"

// TokenSource returns a current token for a station (stationtoken.Source).
type TokenSource interface {
	Token(ctx context.Context, stationID string) (string, error)
}

// Config is what Start needs.
type Config struct {
	// Stations are the hub station ids the proxy serves. Empty means the proxy serves nobody.
	Stations []string
	// HubURL is the hub's MCP endpoint, e.g. https://hub.example/mcp.
	HubURL string
	// SuperlibraryURL is Superlibrary's MCP endpoint. Empty: only the hub is proxied.
	SuperlibraryURL string
	Tokens          TokenSource
	// Logf receives refusals and upstream failures. nil means log.Printf.
	Logf func(format string, args ...any)
	// Listen is the loopback address to bind; empty means 127.0.0.1 on a free port.
	Listen string
}

// Header is one HTTP header of an ACP MCP server entry.
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Server is an ACP `session/new` MCP server entry (the `http` form).
type Server struct {
	Type    string   `json:"type"`
	Name    string   `json:"name"`
	URL     string   `json:"url"`
	Headers []Header `json:"headers"`
}

// Proxy is a running loopback MCP proxy.
type Proxy struct {
	ln        net.Listener
	srv       *http.Server
	secrets   map[string]string // station id → secret
	upstreams map[string]*url.URL
	tokens    TokenSource
	logf      func(format string, args ...any)
}

// upstream path segment → server name, in injection order.
var upstreamOrder = []struct{ segment, name string }{
	{"hub", HubServerName},
	{"superlibrary", SuperlibraryServerName},
}

// Start binds the loopback listener and serves until Close.
func Start(cfg Config) (*Proxy, error) {
	if cfg.Tokens == nil {
		return nil, errors.New("mcpproxy: no token source")
	}
	ups := map[string]*url.URL{}
	for seg, raw := range map[string]string{"hub": cfg.HubURL, "superlibrary": cfg.SuperlibraryURL} {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return nil, fmt.Errorf("mcpproxy: bad %s upstream url", seg)
		}
		ups[seg] = u
	}
	if ups["hub"] == nil {
		return nil, errors.New("mcpproxy: no hub upstream")
	}
	secrets := map[string]string{}
	for _, id := range cfg.Stations {
		id = strings.TrimSpace(id)
		if id == "" || strings.ContainsAny(id, "/?#") {
			continue
		}
		s, err := newSecret()
		if err != nil {
			return nil, err
		}
		secrets[id] = s
	}
	addr := cfg.Listen
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	ln, err := listenLoopback(addr)
	if err != nil {
		return nil, err
	}
	logf := cfg.Logf
	if logf == nil {
		logf = log.Printf
	}
	p := &Proxy{ln: ln, secrets: secrets, upstreams: ups, tokens: cfg.Tokens, logf: logf}
	p.srv = &http.Server{Handler: p, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = p.srv.Serve(ln) }()
	return p, nil
}

// listenLoopback binds addr only when its host is a loopback IP literal. A hostname is refused —
// "localhost" can resolve elsewhere — and so is an unspecified address, which is every interface.
func listenLoopback(addr string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("mcpproxy: refusing to bind %q: loopback IP only", addr)
	}
	return net.Listen("tcp", addr)
}

func newSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// Addr is the bound host:port.
func (p *Proxy) Addr() string { return p.ln.Addr().String() }

// Close stops serving.
func (p *Proxy) Close() error { return p.srv.Close() }

// Serves reports whether the proxy serves a station.
func (p *Proxy) Serves(stationID string) bool { _, ok := p.secrets[stationID]; return ok }

// Servers are the ACP MCP entries for a station's session — nil for a station not served.
func (p *Proxy) Servers(stationID string) []Server {
	secret, ok := p.secrets[stationID]
	if !ok {
		return nil
	}
	var out []Server
	for _, u := range upstreamOrder {
		if p.upstreams[u.segment] == nil {
			continue
		}
		out = append(out, Server{
			Type:    "http",
			Name:    u.name,
			URL:     "http://" + p.Addr() + "/stations/" + url.PathEscape(stationID) + "/mcp/" + u.segment,
			Headers: []Header{{Name: SecretHeader, Value: secret}},
		})
	}
	return out
}

// ServersForHarness is Servers for a station whose harness takes HTTP MCP servers in
// `session/new` — and nil for one that does not, which then gets neither server and a prompt
// that names neither's tools.
func (p *Proxy) ServersForHarness(stationID, harness string) []Server {
	if !SupportsHTTP(harness) {
		return nil
	}
	return p.Servers(stationID)
}

// ServeHTTP authenticates, mints and forwards.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(parts) != 4 || parts[0] != "stations" || parts[2] != "mcp" {
		http.NotFound(w, r)
		return
	}
	stationID, segment := parts[1], parts[3]
	up := p.upstreams[segment]
	if up == nil {
		http.NotFound(w, r)
		return
	}
	want, served := p.secrets[stationID]
	got := r.Header.Get(SecretHeader)
	// Constant time, and the same answer for an unknown station as for a wrong secret, so a
	// caller cannot probe which stations this node serves.
	if !served || got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		reason := "wrong secret"
		switch {
		case !served:
			reason = "station not served"
		case got == "":
			reason = "no secret"
		}
		p.logf("mcp proxy: refused %s %s for station %s (%s) from %s", r.Method, segment, stationID, reason, r.RemoteAddr)
		writeRPCError(w, http.StatusUnauthorized, "refused by the node's MCP proxy")
		return
	}
	token, err := p.tokens.Token(r.Context(), stationID)
	if err != nil {
		p.logf("mcp proxy: no station token for %s: %v", stationID, err)
		writeRPCError(w, http.StatusBadGateway, "the node could not get this station's token")
		return
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = up.Scheme
			pr.Out.URL.Host = up.Host
			pr.Out.URL.Path = up.Path
			pr.Out.URL.RawPath = up.RawPath
			pr.Out.URL.RawQuery = pr.In.URL.RawQuery
			pr.Out.Host = up.Host
			pr.Out.Header.Del(SecretHeader)
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Set("Authorization", "Bearer "+token)
		},
		// Negative: flush every write, so an SSE event reaches the harness when the upstream sends it.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			p.logf("mcp proxy: upstream %s failed for station %s: %v", segment, stationID, err)
			writeRPCError(w, http.StatusBadGateway, "the upstream MCP server could not be reached")
		},
	}
	rp.ServeHTTP(w, r)
}

func writeRPCError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0", "id": nil,
		"error": map[string]any{"code": -32001, "message": msg},
	})
}

// httpMCPHarnesses are the harnesses whose ACP adapter registers HTTP MCP servers from
// `session/new`. Measured 2026-10-09 with an `initialize` probe of each adapter:
//
//	claude-code  claude-agent-acp  mcpCapabilities {http: true, sse: true}
//	codex        codex-acp         mcpCapabilities {http: true, sse: false}
//	opencode     opencode acp      mcpCapabilities {http: true, sse: true}
//	openclaw     openclaw acp      mcpCapabilities {http: false, sse: false}
//	pi           pi-acp            mcpCapabilities {http: false, sse: false}
//	hermes       hermes acp        declares nothing, registers session/new's servers anyway
//	                               (acp_adapter/server.py new_session → _register_session_mcp_servers)
//
// A harness not listed gets no servers, and its prompt names none of their tools.
var httpMCPHarnesses = map[string]bool{"hermes": true, "claude-code": true, "codex": true, "opencode": true}

// SupportsHTTP reports whether a harness takes HTTP MCP servers in session/new.
func SupportsHTTP(harness string) bool { return httpMCPHarnesses[harness] }

// sessionMethods are the ACP calls that carry `mcpServers`.
var sessionMethods = map[string]bool{"session/new": true, "session/load": true, "session/resume": true}

// Inject adds servers to every complete `session/new`, `session/load` or `session/resume` call in
// data (newline-delimited JSON-RPC), replacing an entry of the same name. Everything else — other
// calls, responses, partial lines, non-JSON — passes through byte for byte.
func Inject(data []byte, servers []Server) []byte {
	if len(servers) == 0 || !bytes.Contains(data, []byte(`"session/`)) {
		return data
	}
	var out bytes.Buffer
	rest := data
	changed := false
	for len(rest) > 0 {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			out.Write(rest) // a partial line is not ours to touch
			break
		}
		line := rest[:i]
		rest = rest[i+1:]
		if nl, ok := injectLine(line, servers); ok {
			out.Write(nl)
			changed = true
		} else {
			out.Write(line)
		}
		out.WriteByte('\n')
	}
	if !changed {
		return data
	}
	return out.Bytes()
}

func injectLine(line []byte, servers []Server) ([]byte, bool) {
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(line, &msg); err != nil {
		return nil, false
	}
	var method string
	if err := json.Unmarshal(msg["method"], &method); err != nil || !sessionMethods[method] {
		return nil, false
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(msg["params"], &params); err != nil || params == nil {
		return nil, false
	}
	var existing []json.RawMessage
	if raw, ok := params["mcpServers"]; ok {
		if err := json.Unmarshal(raw, &existing); err != nil {
			return nil, false
		}
	}
	ours := map[string]bool{}
	for _, s := range servers {
		ours[s.Name] = true
	}
	merged := make([]any, 0, len(existing)+len(servers))
	for _, e := range existing {
		var named struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(e, &named) == nil && ours[named.Name] {
			continue
		}
		merged = append(merged, e)
	}
	for _, s := range servers {
		merged = append(merged, s)
	}
	b, err := json.Marshal(merged)
	if err != nil {
		return nil, false
	}
	params["mcpServers"] = b
	if msg["params"], err = json.Marshal(params); err != nil {
		return nil, false
	}
	nl, err := json.Marshal(msg)
	if err != nil {
		return nil, false
	}
	return nl, true
}

// Names lists server names, for the hub's acp.open answer.
func Names(servers []Server) []string {
	out := make([]string, 0, len(servers))
	for _, s := range servers {
		out = append(out, s.Name)
	}
	return out
}
