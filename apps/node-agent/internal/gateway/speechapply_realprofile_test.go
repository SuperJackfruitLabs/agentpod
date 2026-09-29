// External test package for the same reason as
// transcriptionapply_realprofile_test: this drives speech.apply against the
// REAL Hermes TTS writer, and `descriptor` imports `gateway`.
package gateway_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// TestSpeechApplyWritesARealHermesProfile uses the live-host shape of
// ~/.hermes/profiles/writer-quill on guild (2026-09-30), after
// transcription.apply has run on it: the handler, the production adapter and
// the real writer, over a real directory, byte-for-byte.
func TestSpeechApplyWritesARealHermesProfile(t *testing.T) {
	dir := t.TempDir()
	config := "model:\n  default: claude-sonnet\n" +
		"stt:\n  enabled: true\n  provider: openai\n  openai:\n    model: large-v3-turbo\n" +
		"tts:\n" +
		"  provider: cloudflare-aura\n" +
		"  providers:\n" +
		"    cloudflare-aura:\n" +
		"      type: command\n" +
		"      command: /root/maintenance/scripts/cloudflare-aura-tts --input {input_path} --output {output_path} --speaker {voice}\n" +
		"      output_format: mp3\n" +
		"      voice: callista\n" +
		"      timeout: 90\n" +
		"      voice_compatible: true\n" +
		"      max_text_length: 5000\n"
	env := "MATRIX_USER_ID=@a:h\nMATRIX_ACCESS_TOKEN=syt_x\nSTT_OPENAI_BASE_URL=http://100.78.52.87:8840/v1\nVOICE_TOOLS_OPENAI_KEY=sk-stt\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}

	restarted := false
	h := gateway.NewSpeechApplyHandler(adoptPassthrough(), gateway.SpeechApplyDeps{
		Resolver:        gateway.WorkspaceFunc(func(string) (string, error) { return dir, nil }),
		HarnessFor:      func(string) (string, error) { return "hermes", nil },
		CapabilitiesFor: func(string) ([]string, error) { return []string{"lifecycle"}, nil },
		Fetch: func(context.Context, string) (gateway.SpeechConfig, error) {
			return gateway.SpeechConfig{
				Enabled: true, URL: "http://100.78.52.87:8841", APIKey: "sk-tts",
				Voice: "af_heart:60+af_bella:40", SpeakMode: "always",
			}, nil
		},
		Write:   descriptor.WriteHermesSpeech,
		Restart: func(string) error { restarted = true; return nil },
	})

	res, _, err := h.Handle(t.Context(), "speech.apply", json.RawMessage(`{"key":"hermes:writer-quill","stationId":"st_1"}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if !restarted {
		t.Error("not restarted")
	}
	b, _ := json.Marshal(res)
	if string(b) != `{"applied":true,"mode":"on","voice":"af_heart:60+af_bella:40","speakMode":"always","autoSpeak":true,"restarted":true}` {
		t.Errorf("result = %s", b)
	}

	gotEnv, _ := os.ReadFile(filepath.Join(dir, ".env"))
	if want := env + "AGENTPOD_TTS_API_KEY=sk-tts\n"; string(gotEnv) != want {
		t.Errorf(".env = %q, want %q", gotEnv, want)
	}
	gotConfig, _ := os.ReadFile(filepath.Join(dir, "config.yaml"))
	wantConfig := "model:\n  default: claude-sonnet\n" +
		"stt:\n  enabled: true\n  provider: openai\n  openai:\n    model: large-v3-turbo\n" +
		"tts:\n" +
		"  provider: openai\n" +
		"  providers:\n" +
		"    cloudflare-aura:\n" +
		"      type: command\n" +
		"      command: /root/maintenance/scripts/cloudflare-aura-tts --input {input_path} --output {output_path} --speaker {voice}\n" +
		"      output_format: mp3\n" +
		"      voice: callista\n" +
		"      timeout: 90\n" +
		"      voice_compatible: true\n" +
		"      max_text_length: 5000\n" +
		"  openai:\n" +
		"    base_url: http://100.78.52.87:8841/v1\n" +
		"    model: kokoro\n" +
		"    voice: af_heart:60+af_bella:40\n" +
		"    api_key: ${AGENTPOD_TTS_API_KEY}\n" +
		"voice:\n" +
		"  auto_tts: true\n"
	if string(gotConfig) != wantConfig {
		t.Errorf("config.yaml =\n%s\nwant\n%s", gotConfig, wantConfig)
	}
}
