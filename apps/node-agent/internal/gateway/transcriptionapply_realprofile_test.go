// External test package for the same reason as matrixadopt_realprofile_test:
// this drives transcription.apply against the REAL Hermes STT writer, and
// `descriptor` imports `gateway`.
package gateway_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// TestTranscriptionApplyWritesARealHermesProfile uses the live-host shape of
// ~/.hermes/profiles/analyst-echo: the handler, the production adapter and
// the real writer, over a real directory.
func TestTranscriptionApplyWritesARealHermesProfile(t *testing.T) {
	dir := t.TempDir()
	config := "model:\n  default: claude-sonnet\n" +
		"stt:\n  enabled: false\n  provider: local\n"
	env := "MATRIX_USER_ID=@a:h\nMATRIX_ACCESS_TOKEN=syt_x\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}

	restarted := false
	h := gateway.NewTranscriptionApplyHandler(adoptPassthrough(), gateway.TranscriptionApplyDeps{
		Resolver:        gateway.WorkspaceFunc(func(string) (string, error) { return dir, nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		Fetch: func(context.Context, string) (gateway.TranscriptionConfig, error) {
			return gateway.TranscriptionConfig{Enabled: true, URL: "http://100.78.52.87:8840", APIKey: "sk-real", Model: "large-v3-turbo"}, nil
		},
		Write:   descriptor.WriteHermesTranscription,
		Restart: func(string) error { restarted = true; return nil },
	})

	res, _, err := h.Handle(t.Context(), "transcription.apply", json.RawMessage(`{"key":"hermes:analyst-echo","stationId":"st_1"}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if !restarted {
		t.Error("not restarted")
	}
	b, _ := json.Marshal(res)
	if string(b) != `{"applied":true,"mode":"on","model":"large-v3-turbo","restarted":true}` {
		t.Errorf("result = %s", b)
	}

	gotEnv, _ := os.ReadFile(filepath.Join(dir, ".env"))
	wantEnv := env + "STT_OPENAI_BASE_URL=http://100.78.52.87:8840/v1\nVOICE_TOOLS_OPENAI_KEY=sk-real\n"
	if string(gotEnv) != wantEnv {
		t.Errorf(".env = %q, want %q", gotEnv, wantEnv)
	}
	gotConfig, _ := os.ReadFile(filepath.Join(dir, "config.yaml"))
	want := "stt:\n  enabled: true\n  provider: openai\n  openai:\n    model: large-v3-turbo\n"
	if !strings.Contains(string(gotConfig), want) || !strings.Contains(string(gotConfig), "default: claude-sonnet") {
		t.Errorf("config.yaml =\n%s", gotConfig)
	}
}
