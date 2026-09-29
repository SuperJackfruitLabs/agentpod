package descriptor

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const ttsTestKey = "sk-tts-secret-never-in-errors"

// guildWriterQuill is the tts section of ~/.hermes/profiles/writer-quill on
// the guild host (read 2026-09-30): the operator's cloudflare-aura command
// provider, which must survive every write byte-for-byte in meaning.
const guildWriterQuill = "model:\n" +
	"  default: claude-sonnet   # the model this agent runs\n" +
	"stt:\n" +
	"  enabled: true\n" +
	"  provider: openai\n" +
	"  openai:\n" +
	"    model: large-v3-turbo\n" +
	"# the operator's fallback voice\n" +
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

func ttsOn(mode string) HermesTTSSetting {
	return HermesTTSSetting{
		Enabled:   true,
		URL:       "http://100.78.52.87:8841/",
		APIKey:    ttsTestKey,
		Voice:     "af_heart:60+af_bella:40",
		SpeakMode: mode,
	}
}

// configOf decodes config.yaml as plain data.
func configOf(t *testing.T, dir string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(readFile(t, filepath.Join(dir, "config.yaml"))), &doc); err != nil {
		t.Fatalf("config.yaml no longer parses: %v", err)
	}
	return doc
}

func section(doc map[string]any, keys ...string) any {
	var cur any = doc
	for _, k := range keys {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[k]
	}
	return cur
}

func TestHermesTTSPointsTheProfileAtTheSpeechService(t *testing.T) {
	dir := sttProfile(t, guildWriterQuill, true, "MATRIX_ACCESS_TOKEN=syt_x\n", true)
	auto, err := WriteHermesTTS(dir, ttsOn("voice_in"))
	if err != nil {
		t.Fatalf("WriteHermesTTS: %v", err)
	}
	doc := configOf(t, dir)
	if got := section(doc, "tts", "provider"); got != "openai" {
		t.Errorf("tts.provider = %v, want openai", got)
	}
	wantOpenAI := map[string]any{
		"base_url": "http://100.78.52.87:8841/v1",
		"model":    "kokoro",
		"voice":    "af_heart:60+af_bella:40",
		"api_key":  "${AGENTPOD_TTS_API_KEY}",
	}
	if got := section(doc, "tts", "openai"); !reflect.DeepEqual(got, wantOpenAI) {
		t.Errorf("tts.openai = %#v, want %#v", got, wantOpenAI)
	}
	// The operator's fallback provider is untouched.
	wantAura := map[string]any{
		"type":             "command",
		"command":          "/root/maintenance/scripts/cloudflare-aura-tts --input {input_path} --output {output_path} --speaker {voice}",
		"output_format":    "mp3",
		"voice":            "callista",
		"timeout":          90,
		"voice_compatible": true,
		"max_text_length":  5000,
	}
	if got := section(doc, "tts", "providers", "cloudflare-aura"); !reflect.DeepEqual(got, wantAura) {
		t.Errorf("cloudflare-aura = %#v, want it unchanged", got)
	}
	// voice_in has no Hermes setting: voice.auto_tts is not invented.
	if section(doc, "voice") != nil {
		t.Errorf("voice = %#v, want no voice section for voice_in", section(doc, "voice"))
	}
	if auto {
		t.Error("autoSpeak = true for a profile with no voice.auto_tts")
	}
	raw := readFile(t, filepath.Join(dir, "config.yaml"))
	for _, keep := range []string{"# the model this agent runs", "# the operator's fallback voice", "model: large-v3-turbo"} {
		if !strings.Contains(raw, keep) {
			t.Errorf("config.yaml lost %q:\n%s", keep, raw)
		}
	}
	if strings.Contains(raw, ttsTestKey) {
		t.Error("the API key was written into config.yaml")
	}
}

func TestHermesTTSSpeakModes(t *testing.T) {
	cases := []struct {
		name      string
		voice     string // the profile's voice section, "" for none
		mode      string
		wantAuto  any // voice.auto_tts after the write, nil = absent
		wantSpeak bool
	}{
		{"always turns auto_tts on", "", "always", true, true},
		{"always keeps the rest of voice", "voice:\n  record_key: ctrl+b\n  auto_tts: false\n", "always", true, true},
		{"off turns an on auto_tts off", "voice:\n  auto_tts: true\n", "off", false, false},
		{"off leaves an absent auto_tts absent (Hermes defaults it off)", "", "off", nil, false},
		{"voice_in leaves an on auto_tts on, and says so", "voice:\n  auto_tts: true\n", "voice_in", true, true},
		{"voice_in leaves an off auto_tts off", "voice:\n  auto_tts: false\n", "voice_in", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := sttProfile(t, "model:\n  default: x\n"+tc.voice, true, "", true)
			auto, err := WriteHermesTTS(dir, ttsOn(tc.mode))
			if err != nil {
				t.Fatalf("WriteHermesTTS: %v", err)
			}
			if got := section(configOf(t, dir), "voice", "auto_tts"); got != tc.wantAuto {
				t.Errorf("voice.auto_tts = %#v, want %#v", got, tc.wantAuto)
			}
			if auto != tc.wantSpeak {
				t.Errorf("autoSpeak = %v, want %v", auto, tc.wantSpeak)
			}
			if strings.Contains(tc.voice, "record_key") && section(configOf(t, dir), "voice", "record_key") != "ctrl+b" {
				t.Error("voice.record_key was lost")
			}
		})
	}
}

func TestHermesTTSDisabled(t *testing.T) {
	config := guildWriterQuill + "voice:\n  auto_tts: true\n"
	env := "MATRIX_ACCESS_TOKEN=syt_x\nAGENTPOD_TTS_API_KEY=old\n"
	dir := sttProfile(t, config, true, env, true)
	auto, err := WriteHermesTTS(dir, HermesTTSSetting{Enabled: false})
	if err != nil {
		t.Fatalf("WriteHermesTTS: %v", err)
	}
	if auto {
		t.Error("autoSpeak = true after turning speech off")
	}
	doc := configOf(t, dir)
	if got := section(doc, "voice", "auto_tts"); got != false {
		t.Errorf("voice.auto_tts = %#v, want false", got)
	}
	// The provider is left as it was: turning speech off must not throw away
	// a working endpoint (or the operator's own provider).
	if got := section(doc, "tts", "provider"); got != "cloudflare-aura" {
		t.Errorf("tts.provider = %v, want it untouched", got)
	}
	if got := readFile(t, filepath.Join(dir, ".env")); got != env {
		t.Errorf(".env = %q, want it untouched", got)
	}
}

func TestHermesTTSEnv(t *testing.T) {
	env := "# comment\nexport MATRIX_ACCESS_TOKEN=syt_x\nVOICE_TOOLS_OPENAI_KEY=sk-stt\nAGENTPOD_TTS_API_KEY=old\nTAIL=1"
	dir := sttProfile(t, guildWriterQuill, true, env, true)
	if err := os.Chmod(filepath.Join(dir, ".env"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteHermesTTS(dir, ttsOn("always")); err != nil {
		t.Fatalf("WriteHermesTTS: %v", err)
	}
	want := "# comment\nexport MATRIX_ACCESS_TOKEN=syt_x\nVOICE_TOOLS_OPENAI_KEY=sk-stt\nAGENTPOD_TTS_API_KEY=" + ttsTestKey + "\nTAIL=1"
	if got := readFile(t, filepath.Join(dir, ".env")); got != want {
		t.Errorf(".env =\n%q\nwant\n%q", got, want)
	}
	info, err := os.Stat(filepath.Join(dir, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf(".env mode = %o, want 0600", info.Mode().Perm())
	}

	// Absent: appended, and the STT key (a different service's) is not touched.
	dir = sttProfile(t, "", true, "VOICE_TOOLS_OPENAI_KEY=sk-stt\n", true)
	if _, err := WriteHermesTTS(dir, ttsOn("always")); err != nil {
		t.Fatalf("WriteHermesTTS: %v", err)
	}
	if got := readFile(t, filepath.Join(dir, ".env")); got != "VOICE_TOOLS_OPENAI_KEY=sk-stt\nAGENTPOD_TTS_API_KEY="+ttsTestKey+"\n" {
		t.Errorf(".env = %q", got)
	}
}

func TestHermesTTSIsIdempotent(t *testing.T) {
	dir := sttProfile(t, guildWriterQuill, true, "A=1\n", true)
	if _, err := WriteHermesTTS(dir, ttsOn("always")); err != nil {
		t.Fatal(err)
	}
	first := readFile(t, filepath.Join(dir, "config.yaml")) + readFile(t, filepath.Join(dir, ".env"))
	if _, err := WriteHermesTTS(dir, ttsOn("always")); err != nil {
		t.Fatal(err)
	}
	if second := readFile(t, filepath.Join(dir, "config.yaml")) + readFile(t, filepath.Join(dir, ".env")); second != first {
		t.Errorf("a second write changed the profile:\n%s\n---\n%s", first, second)
	}
}

func TestHermesTTSRefusals(t *testing.T) {
	cases := []struct {
		name       string
		config     string
		withConfig bool
		withEnv    bool
		setting    HermesTTSSetting
		want       string
	}{
		{"no config.yaml", "", false, true, ttsOn("always"), "no config.yaml"},
		{"no .env", "model: x\n", true, false, ttsOn("always"), "no .env"},
		{"not yaml", "model: [x\n", true, true, ttsOn("always"), "not valid YAML"},
		{"a list at the root", "- a\n- b\n", true, true, ttsOn("always"), "not a mapping"},
		{"tts is a scalar", "tts: edge\n", true, true, ttsOn("always"), "tts is not a mapping"},
		{"tts.openai is a list", "tts:\n  openai: [a]\n", true, true, ttsOn("always"), "tts.openai is not a mapping"},
		{"voice is a scalar", "voice: loud\n", true, true, ttsOn("always"), "voice is not a mapping"},
		{"voice is a scalar, speech off", "voice: loud\n", true, true, HermesTTSSetting{}, "voice is not a mapping"},
		{"no url", "model: x\n", true, true, HermesTTSSetting{Enabled: true, APIKey: ttsTestKey, Voice: "af_heart", SpeakMode: "always"}, "no service url"},
		{"no voice", "model: x\n", true, true, HermesTTSSetting{Enabled: true, URL: "http://s", APIKey: ttsTestKey, SpeakMode: "always"}, "no voice"},
		{"unknown speak mode", "model: x\n", true, true, HermesTTSSetting{Enabled: true, URL: "http://s", APIKey: ttsTestKey, Voice: "af_heart", SpeakMode: "sometimes"}, "speak mode"},
		{"a newline in the key", "model: x\n", true, true, HermesTTSSetting{Enabled: true, URL: "http://s", APIKey: ttsTestKey + "\nEVIL=1", Voice: "af_heart", SpeakMode: "always"}, "newline"},
		{"a newline in the voice", "model: x\n", true, true, HermesTTSSetting{Enabled: true, URL: "http://s", APIKey: ttsTestKey, Voice: "af\nx", SpeakMode: "always"}, "newline"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := "A=1\n"
			dir := sttProfile(t, tc.config, tc.withConfig, env, tc.withEnv)
			_, err := WriteHermesTTS(dir, tc.setting)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
			if strings.Contains(err.Error(), ttsTestKey) {
				t.Errorf("error carries the key: %q", err)
			}
			if tc.withConfig {
				if got := readFile(t, filepath.Join(dir, "config.yaml")); got != tc.config {
					t.Errorf("config.yaml changed after a refusal:\n%s", got)
				}
			}
			if tc.withEnv {
				if got := readFile(t, filepath.Join(dir, ".env")); got != env {
					t.Errorf(".env changed after a refusal: %q", got)
				}
			}
		})
	}
}

// TestSameOutsideTTS: an edit may change tts.provider, the four tts.openai
// keys this writer owns and voice.auto_tts — nothing else, not even another
// key inside `tts` (the operator's fallback provider lives there).
func TestSameOutsideTTS(t *testing.T) {
	before := []byte("model: x\ntts:\n  provider: edge\n  providers:\n    a: {type: command}\nvoice:\n  auto_tts: false\n  record_key: ctrl+b\n")
	ok := []byte("model: x\ntts:\n  provider: openai\n  openai: {base_url: u, model: kokoro, voice: v, api_key: k}\n  providers:\n    a: {type: command}\nvoice:\n  auto_tts: true\n  record_key: ctrl+b\n")
	if err := sameOutsideTTS(before, ok); err != nil {
		t.Errorf("an allowed edit was refused: %v", err)
	}
	for name, after := range map[string]string{
		"another top-level key":  "model: y\ntts:\n  provider: openai\n  providers:\n    a: {type: command}\nvoice:\n  auto_tts: false\n  record_key: ctrl+b\n",
		"the fallback provider":  "model: x\ntts:\n  provider: openai\n  providers:\n    a: {type: shell}\nvoice:\n  auto_tts: false\n  record_key: ctrl+b\n",
		"another voice key":      "model: x\ntts:\n  provider: edge\n  providers:\n    a: {type: command}\nvoice:\n  auto_tts: false\n  record_key: ctrl+c\n",
		"another tts.openai key": "model: x\ntts:\n  provider: edge\n  openai: {speed: 2}\n  providers:\n    a: {type: command}\nvoice:\n  auto_tts: false\n  record_key: ctrl+b\n",
	} {
		if err := sameOutsideTTS(before, []byte(after)); err == nil {
			t.Errorf("%s: a collateral change was allowed", name)
		}
	}
	// An added empty `voice:` or `tts.openai:` is not a change.
	if err := sameOutsideTTS([]byte("model: x\n"), []byte("model: x\nvoice: {}\ntts:\n  openai: {}\n")); err != nil {
		t.Errorf("an empty section counted as a change: %v", err)
	}
}
