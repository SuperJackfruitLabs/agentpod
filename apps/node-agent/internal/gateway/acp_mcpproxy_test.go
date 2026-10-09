package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/acp"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/mcpproxy"
)

// proxyFor serves one station on one supported harness, as run.go wires the real proxy.
func proxyFor(station, harness string) MCPProxyFunc {
	return func(stationID, key string) []mcpproxy.Server {
		if stationID != station || !mcpproxy.SupportsHTTP(harness) {
			return nil
		}
		return []mcpproxy.Server{
			{Type: "http", Name: mcpproxy.HubServerName, URL: "http://127.0.0.1:9/stations/" + stationID + "/mcp/hub", Headers: []mcpproxy.Header{{Name: mcpproxy.SecretHeader, Value: "s3cret"}}},
			{Type: "http", Name: mcpproxy.SuperlibraryServerName, URL: "http://127.0.0.1:9/stations/" + stationID + "/mcp/superlibrary", Headers: []mcpproxy.Header{{Name: mcpproxy.SecretHeader, Value: "s3cret"}}},
		}
	}
}

func openWith(t *testing.T, h Handler, params string) map[string]any {
	t.Helper()
	res, _, err := h.Handle(context.Background(), "acp.open", json.RawMessage(params), nil)
	if err != nil {
		t.Fatalf("acp.open: %v", err)
	}
	return res.(map[string]any)
}

func TestACPOpenEchoesTheProxiedServersOnlyWhenItInjects(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)
	h := NewACPHandlerWithMCPProxy(failInner(t), mgr, catCommandFunc(t.TempDir()), proxyFor("station_a", "hermes"))

	got := openWith(t, h, `{"key":"hermes:x","instance":"i1","mcpProxy":{"stationId":"station_a"}}`)
	names, _ := got["mcpProxy"].([]string)
	if fmt.Sprint(names) != "[agentpod superlibrary]" {
		t.Fatalf("mcpProxy = %v", got["mcpProxy"])
	}
	// Not asked: nothing echoed. Another station: nothing echoed.
	if _, present := openWith(t, h, `{"key":"hermes:x","instance":"i2"}`)["mcpProxy"]; present {
		t.Fatal("echoed without being asked")
	}
	if _, present := openWith(t, h, `{"key":"hermes:x","instance":"i3","mcpProxy":{"stationId":"station_b"}}`)["mcpProxy"]; present {
		t.Fatal("echoed for a station the proxy does not serve")
	}
}

func TestAHarnessWithoutHTTPMCPGetsNeitherServer(t *testing.T) {
	for _, harness := range []string{"openclaw", "pi"} {
		mgr := acp.NewManager()
		t.Cleanup(mgr.Shutdown)
		h := NewACPHandlerWithMCPProxy(failInner(t), mgr, catCommandFunc(t.TempDir()), proxyFor("station_a", harness))
		got := openWith(t, h, `{"key":"k","instance":"i","mcpProxy":{"stationId":"station_a"}}`)
		if _, present := got["mcpProxy"]; present {
			t.Fatalf("%s: echoed servers it cannot use", harness)
		}
		if servers := h.(*acpHandler).injectionFor(got["sessionId"].(string)); len(servers) != 0 {
			t.Fatalf("%s: would inject %v", harness, servers)
		}
	}
}

// End to end through the dispatch loop: the harness (cat, echoing its stdin) receives a
// session/new carrying the proxied servers — and the hub never sent them.
func TestSessionNewReachesTheHarnessWithTheProxiedServers(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)
	h := NewACPHandlerWithMCPProxy(failInner(t), mgr, catCommandFunc(t.TempDir()), proxyFor("station_a", "codex"))
	rig := newACPTestRig(t, h)

	rig.writeHub(`{"type":"req","id":"open-1","verb":"acp.open","params":{"key":"codex:x","instance":"i","mcpProxy":{"stationId":"station_a"}}}`)
	msg := rig.readFrame()
	data, _ := msg["data"].(map[string]any)
	sessionID, _ := data["sessionId"].(string)
	if sessionID == "" {
		t.Fatalf("open failed: %v", msg)
	}
	rig.writeHub(fmt.Sprintf(`{"type":"req","id":"attach-1","verb":"acp.attach","params":{"sessionId":"%s"}}`, sessionID))
	time.Sleep(50 * time.Millisecond)

	line := `{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/w","mcpServers":[{"type":"http","name":"superpipeline","url":"https://sp/mcp","headers":[]}]}}` + "\n"
	rig.writeHub(fmt.Sprintf(`{"type":"input","id":"%s","data":"%s"}`, sessionID, base64.StdEncoding.EncodeToString([]byte(line))))
	if !rig.awaitStreamContaining(`/stations/station_a/mcp/superlibrary`) {
		t.Fatal("the harness's session/new lacks the proxied servers")
	}
}

func TestAnUnproxiedSessionIsPassedThroughUnchanged(t *testing.T) {
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)
	h := NewACPHandlerWithMCPProxy(failInner(t), mgr, catCommandFunc(t.TempDir()), proxyFor("station_a", "codex"))
	got := openWith(t, h, `{"key":"codex:x","instance":"plain"}`)
	if servers := h.(*acpHandler).injectionFor(got["sessionId"].(string)); len(servers) != 0 {
		t.Fatalf("an unproxied session would be injected: %v", servers)
	}
}
