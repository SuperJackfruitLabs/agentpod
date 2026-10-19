package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/acp"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/mcpproxy"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

type salaamMCPTransport func(*http.Request) (*http.Response, error)

func (f salaamMCPTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func mcpFingerprint(value any) string {
	b, _ := json.Marshal(value)
	var decoded any
	_ = json.Unmarshal(b, &decoded)
	b, _ = json.Marshal(decoded)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func TestSalaamGatewayAssignsProxyPrivatelyAndInjectsNoCredentials(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)
	b := salaam.Binding{Version: 1, OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000002", NodeID: "node_fixture", StationID: "station_fixture", StationKey: salaam.StationKey("/workspace"), OccupancyEpoch: 3, HubSessionID: "acps_fixture", Workspace: "/workspace", Run: salaam.Run{Source: "superpipeline", ID: "run_fixture", Epoch: 7}}
	const secret = "offline-private-proxy-credential-never-real"
	servers := []mcpproxy.Server{{Type: "http", Name: "superlibrary", URL: "http://127.0.0.1:43421/stations/station_fixture/mcp-managed-v1/" + mcpFingerprint(b) + "/superlibrary", Headers: []mcpproxy.Header{{Name: mcpproxy.SecretHeader, Value: secret}}, CredentialGeneration: 4}}
	assignments := 0
	deny := false
	c := &salaam.Client{NodeID: b.NodeID, Workspace: b.Workspace, HTTP: &http.Client{Transport: salaamMCPTransport(func(r *http.Request) (*http.Response, error) {
		var out any
		status := 200
		if r.Method == "GET" {
			out = map[string]any{"service": "healthy", "managed_mcp": map[string]any{"profile_digest": strings.Repeat("a", 64)}}
		} else if strings.HasSuffix(r.URL.Path, "/admit") || strings.HasSuffix(r.URL.Path, "/status") {
			out = map[string]any{"binding": b, "authorized": true, "token": "offline-local-control-token", "admission_id": "admission", "session_id": "local-session"}
		} else {
			if !strings.HasSuffix(r.URL.Path, "/mcp-assign") {
				t.Fatal("unexpected control route")
			}
			assignments++
			var input struct {
				Binding    salaam.Binding       `json:"binding"`
				Assignment salaam.MCPAssignment `json:"assignment"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input.Binding != b || input.Assignment.Binding != b || input.Assignment.CredentialGeneration != 4 || input.Assignment.Servers[0].Headers[0].Value != secret {
				t.Fatal("daemon assignment lost its authority/credential binding")
			}
			out = salaam.MCPView{Version: 1, ProfileDigest: strings.Repeat("a", 64), BindingDigest: mcpFingerprint(b), AssignmentDigest: mcpFingerprint(input.Assignment), CredentialGeneration: 4, Servers: []salaam.MCPServerView{{Name: "superlibrary", EndpointDigest: mcpFingerprint(servers[0].URL), CatalogDigest: strings.Repeat("b", 64), Tools: []salaam.MCPToolPin{{Name: "library_search", SchemaDigest: strings.Repeat("c", 64), Policy: "read"}}}}}
			if deny {
				status = 409
			}
		}
		data, _ := json.Marshal(out)
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}}
	c.BindMCP = func(station string, identity mcpproxy.Identity) ([]mcpproxy.Server, error) {
		if station != b.StationID || identity.BindingDigest != mcpFingerprint(b) {
			t.Fatal("gateway proxy binding differs from admitted root")
		}
		return servers, nil
	}
	inner := NewACPHandlerWithMCPProxy(failInner(t), mgr, catCommandFunc(t.TempDir()), func(station, key string) []mcpproxy.Server {
		if station != b.StationID || key != b.StationKey {
			t.Fatal("proxy requested outside the admitted station")
		}
		return servers
	})
	h := NewSalaamHandler(inner, c)
	input := map[string]any{"key": b.StationKey, "instance": b.HubSessionID, "salaamAuthority": b, "mcpProxy": map[string]string{"stationId": b.StationID}}
	raw, _ := json.Marshal(input)
	result, _, err := h.Handle(context.Background(), "acp.open", raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	public := result.(map[string]any)
	injected := inner.(*acpHandler).injectionFor(public["sessionId"].(string))
	if assignments != 1 || len(injected) != 1 || len(injected[0].Headers) != 0 {
		t.Fatal("proxy assignment was not private")
	}
	wire, _ := json.Marshal(injected)
	if strings.Contains(string(wire), secret) {
		t.Fatal("proxy credential entered ACP input")
	}
	if len(public["mcpProxy"].([]string)) != 1 {
		t.Fatal("verified MCP server was not reported")
	}
	input["mcpProxy"] = map[string]string{"stationId": "foreign"}
	raw, _ = json.Marshal(input)
	if _, _, err := h.Handle(context.Background(), "acp.open", raw, nil); err == nil {
		t.Fatal("foreign station reached MCP admission")
	}
	input["mcpProxy"] = map[string]string{"stationId": b.StationID}
	raw, _ = json.Marshal(input)
	deny = true
	if _, _, err := h.Handle(context.Background(), "acp.open", raw, nil); err == nil {
		t.Fatal("daemon assignment refusal was hidden")
	}
}
