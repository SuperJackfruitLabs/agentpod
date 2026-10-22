package descriptor

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// A /v1/health shaped like staging's, secrets included where a careless reader would leak them.
const salaamHealthWithConfig = `{"service":"healthy","agentpod_config":"/p.json","pid":1,
 "agentpod_pins_digest":"ead22c0d",
 "provider_route":{"provider":"kimi-coding","model":"k3","max_tokens":4096,
   "connection":{"endpoint":"https://api.kimi.com/coding/v1","configuration":{"api_key":"sk-SECRET"}}},
 "operator_mcp":{"config":"/home/salaam/.config/salaam/mcp.json","digest":"295b",
   "servers":[{"name":"fetch","source":"operator","transport":"stdio","command":"/usr/local/bin/stk",
     "args":["mcp","serve","--token","tok-SECRET"],"env":{"K":"env-SECRET"},"declaration_digest":"3154"}]}}`

func salaamWithHealth(t *testing.T, body string) (*salaamDescriptor, string) {
	t.Helper()
	base, err := os.MkdirTemp("/tmp", "sal-cfg-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	base, _ = filepath.EvalSymlinks(base)
	ws := filepath.Join(base, "workspace")
	_ = os.Mkdir(ws, 0o700)
	l, err := net.Listen("unix", filepath.Join(base, "operator.sock"))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) })}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	bin, _ := os.Executable()
	return &salaamDescriptor{config: SalaamConfig{Binary: bin, StateDir: base, Workspace: ws}}, salaam.StationKey(ws)
}

func TestSalaamReportsItsConfigurationWithoutSecrets(t *testing.T) {
	s, key := salaamWithHealth(t, salaamHealthWithConfig)
	got := s.ConfigSettings()
	if len(got) != 4 {
		t.Fatalf("an unmanaged Salaam must still report its configuration: %+v", got)
	}
	for _, g := range got {
		if g.Policy != "report-only" || g.RestartToTakeEffect {
			t.Fatalf("report-only setting is writable: %+v", g)
		}
	}
	values, err := s.ObserveConfig(context.Background(), key, []string{"salaam.provider.route", "salaam.mcp.operator", "salaam.agentpod.pins", "salaam.tools.user"})
	if err != nil || len(values) != 4 {
		t.Fatalf("observe: %+v %v", values, err)
	}
	encoded, _ := json.Marshal(values)
	for _, secret := range []string{"SECRET", "/usr/local/bin/stk", "mcp.json", "configuration"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("observation leaked %q: %s", secret, encoded)
		}
	}
	want := `[{"settingId":"salaam.provider.route","observed":{"endpoint":"https://api.kimi.com/coding/v1","model":"k3","provider":"kimi-coding"},"readable":true},` +
		`{"settingId":"salaam.mcp.operator","observed":{"digest":"295b","servers":[{"declarationDigest":"3154","name":"fetch","transport":"stdio"}]},"readable":true},` +
		`{"settingId":"salaam.agentpod.pins","observed":"ead22c0d","readable":true},` +
		`{"settingId":"salaam.tools.user","readable":true}]`
	if string(encoded) != want {
		t.Fatalf("observations:\n got %s\nwant %s", encoded, want)
	}
}

func TestSalaamConfigurationUnreadableIsNeverAbsent(t *testing.T) {
	s, key := salaamWithHealth(t, `not json`)
	values, err := s.ObserveConfig(context.Background(), key, []string{"salaam.provider.route"})
	if err != nil || len(values) != 1 || values[0].Readable || values[0].Reason == "" {
		t.Fatalf("unreadable daemon reported as readable: %+v %v", values, err)
	}
}

func TestSalaamConfigurationRefusesOtherStationsAndSettings(t *testing.T) {
	s, key := salaamWithHealth(t, salaamHealthWithConfig)
	if _, err := s.ObserveConfig(context.Background(), "salaam:0000000000000000", []string{"salaam.provider.route"}); err == nil {
		t.Fatal("observed another station")
	}
	if _, err := s.ObserveConfig(context.Background(), key, []string{"salaam.host.manifest"}); err == nil {
		t.Fatal("manifest observed without a reviewed runtime")
	}
	if _, err := s.ObserveConfig(context.Background(), key, []string{"auth.json"}); err == nil {
		t.Fatal("unknown setting observed")
	}
}
