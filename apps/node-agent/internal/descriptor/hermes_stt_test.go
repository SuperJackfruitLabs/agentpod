package descriptor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const sttTestKey = "sk-stt-secret-never-in-errors"

// sttProfile lays down a Hermes profile with the given config.yaml and .env
// contents (either may be "" with present=false to leave it absent).
func sttProfile(t *testing.T, config string, withConfig bool, env string, withEnv bool) string {
	t.Helper()
	dir := t.TempDir()
	if withConfig {
		if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(config), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	if withEnv {
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// sttOf decodes config.yaml's stt section as plain data.
func sttOf(t *testing.T, dir string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(readFile(t, filepath.Join(dir, "config.yaml"))), &doc); err != nil {
		t.Fatalf("config.yaml no longer parses: %v", err)
	}
	stt, _ := doc["stt"].(map[string]any)
	return stt
}

func onSetting() HermesSTTSetting {
	return HermesSTTSetting{Enabled: true, URL: "http://100.78.52.87:8840/", APIKey: sttTestKey, Model: "large-v3-turbo"}
}

func TestHermesSTTConfigYAML(t *testing.T) {
	cases := []struct {
		name    string
		config  string
		setting HermesSTTSetting
		// wantSTT is the stt section after the write, as plain data.
		wantSTT map[string]any
		// mustContain are substrings (comments, unrelated keys) that must
		// survive the edit byte-for-byte.
		mustContain []string
	}{
		{
			name: "creates a missing stt section and keeps unrelated keys and comments",
			config: "# operator's header comment\n" +
				"model:\n" +
				"  default: claude-sonnet   # the model this agent runs\n" +
				"toolsets:\n" +
				"  - web\n" +
				"  - terminal\n",
			setting: onSetting(),
			wantSTT: map[string]any{"enabled": true, "provider": "openai", "openai": map[string]any{"model": "large-v3-turbo"}},
			mustContain: []string{
				"# operator's header comment",
				"# the model this agent runs",
				"default: claude-sonnet",
				"  - web\n  - terminal",
			},
		},
		{
			name: "updates the live-host shape in place",
			config: "model:\n  default: x\n" +
				"stt:\n" +
				"  enabled: false  # was off\n" +
				"  provider: local\n" +
				"  local:\n" +
				"    model: base\n" +
				"  openai:\n" +
				"    model: whisper-1\n" +
				"memory:\n  enabled: true\n",
			setting: onSetting(),
			wantSTT: map[string]any{
				"enabled":  true,
				"provider": "openai",
				"local":    map[string]any{"model": "base"},
				"openai":   map[string]any{"model": "large-v3-turbo"},
			},
			mustContain: []string{"# was off", "memory:\n  enabled: true"},
		},
		{
			name:        "fills an empty stt key",
			config:      "stt:\nother: 1\n",
			setting:     onSetting(),
			wantSTT:     map[string]any{"enabled": true, "provider": "openai", "openai": map[string]any{"model": "large-v3-turbo"}},
			mustContain: []string{"other: 1"},
		},
		{
			name:        "disabled sets enabled false and leaves the rest of stt alone",
			config:      "stt:\n  enabled: true\n  provider: openai\n  openai:\n    model: large-v3-turbo\nkeep: me\n",
			setting:     HermesSTTSetting{Enabled: false},
			wantSTT:     map[string]any{"enabled": false, "provider": "openai", "openai": map[string]any{"model": "large-v3-turbo"}},
			mustContain: []string{"keep: me"},
		},
		{
			name:        "disabled creates stt.enabled false when there is no stt section",
			config:      "keep: me\n",
			setting:     HermesSTTSetting{Enabled: false},
			wantSTT:     map[string]any{"enabled": false},
			mustContain: []string{"keep: me"},
		},
		{
			name:    "an empty config.yaml gets an stt section",
			config:  "",
			setting: onSetting(),
			wantSTT: map[string]any{"enabled": true, "provider": "openai", "openai": map[string]any{"model": "large-v3-turbo"}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := sttProfile(t, tc.config, true, "OPENAI_API_KEY=x\n", true)
			if err := WriteHermesSTT(dir, tc.setting); err != nil {
				t.Fatalf("WriteHermesSTT: %v", err)
			}
			got := sttOf(t, dir)
			if !equalData(got, tc.wantSTT) {
				t.Errorf("stt = %#v, want %#v", got, tc.wantSTT)
			}
			out := readFile(t, filepath.Join(dir, "config.yaml"))
			for _, s := range tc.mustContain {
				if !strings.Contains(out, s) {
					t.Errorf("config.yaml lost %q:\n%s", s, out)
				}
			}
			info, err := os.Stat(filepath.Join(dir, "config.yaml"))
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o640 {
				t.Errorf("config.yaml mode = %o, want the file's own 0640 kept", info.Mode().Perm())
			}
		})
	}
}

func equalData(a, b any) bool {
	ab, _ := yaml.Marshal(a)
	bb, _ := yaml.Marshal(b)
	return string(ab) == string(bb)
}

func TestHermesSTTEnv(t *testing.T) {
	cases := []struct {
		name    string
		env     string
		setting HermesSTTSetting
		want    string
	}{
		{
			name:    "replaces existing lines and leaves others byte-identical",
			env:     "# comment\nOPENAI_API_KEY=abc\nSTT_OPENAI_BASE_URL=http://old:1/v1\nexport VOICE_TOOLS_OPENAI_KEY=old\n  SPACED = kept as is \n",
			setting: onSetting(),
			want:    "# comment\nOPENAI_API_KEY=abc\nSTT_OPENAI_BASE_URL=http://100.78.52.87:8840/v1\nexport VOICE_TOOLS_OPENAI_KEY=" + sttTestKey + "\n  SPACED = kept as is \n",
		},
		{
			name:    "appends absent lines",
			env:     "OPENAI_API_KEY=abc\n",
			setting: onSetting(),
			want:    "OPENAI_API_KEY=abc\nSTT_OPENAI_BASE_URL=http://100.78.52.87:8840/v1\nVOICE_TOOLS_OPENAI_KEY=" + sttTestKey + "\n",
		},
		{
			name:    "appends after a file with no trailing newline",
			env:     "OPENAI_API_KEY=abc",
			setting: onSetting(),
			want:    "OPENAI_API_KEY=abc\nSTT_OPENAI_BASE_URL=http://100.78.52.87:8840/v1\nVOICE_TOOLS_OPENAI_KEY=" + sttTestKey + "\n",
		},
		{
			name:    "a url already ending in /v1 is not doubled",
			env:     "",
			setting: HermesSTTSetting{Enabled: true, URL: "https://api.openai.com/v1/", APIKey: sttTestKey, Model: "whisper-1"},
			want:    "STT_OPENAI_BASE_URL=https://api.openai.com/v1\nVOICE_TOOLS_OPENAI_KEY=" + sttTestKey + "\n",
		},
		{
			name:    "disabled leaves .env alone",
			env:     "STT_OPENAI_BASE_URL=http://old:1/v1\nVOICE_TOOLS_OPENAI_KEY=old",
			setting: HermesSTTSetting{Enabled: false},
			want:    "STT_OPENAI_BASE_URL=http://old:1/v1\nVOICE_TOOLS_OPENAI_KEY=old",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := sttProfile(t, "stt:\n  enabled: false\n", true, tc.env, true)
			if err := WriteHermesSTT(dir, tc.setting); err != nil {
				t.Fatalf("WriteHermesSTT: %v", err)
			}
			if got := readFile(t, filepath.Join(dir, ".env")); got != tc.want {
				t.Errorf(".env =\n%q\nwant\n%q", got, tc.want)
			}
			info, err := os.Stat(filepath.Join(dir, ".env"))
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Errorf(".env mode = %o, want 0600", info.Mode().Perm())
			}
			leftovers, _ := filepath.Glob(filepath.Join(dir, ".tmp-*"))
			if len(leftovers) != 0 {
				t.Errorf("temp files left behind: %v", leftovers)
			}
		})
	}
}

func TestHermesSTTRefusals(t *testing.T) {
	cases := []struct {
		name       string
		config     string
		withConfig bool
		env        string
		withEnv    bool
		setting    HermesSTTSetting
		wantErr    string
	}{
		{name: "no .env", config: "a: 1\n", withConfig: true, setting: onSetting(), wantErr: ".env"},
		{name: "no config.yaml", env: "A=1\n", withEnv: true, setting: onSetting(), wantErr: "config.yaml"},
		{name: "stt is not a mapping", config: "stt: [1, 2]\n", withConfig: true, env: "A=1\n", withEnv: true, setting: onSetting(), wantErr: "stt"},
		{name: "config is not a mapping", config: "- 1\n- 2\n", withConfig: true, env: "A=1\n", withEnv: true, setting: onSetting(), wantErr: "mapping"},
		{name: "invalid yaml", config: "a: [\n", withConfig: true, env: "A=1\n", withEnv: true, setting: onSetting(), wantErr: "YAML"},
		{
			name: "a key with a newline would inject a line", config: "a: 1\n", withConfig: true, env: "A=1\n", withEnv: true,
			setting: HermesSTTSetting{Enabled: true, URL: "http://h:1", APIKey: sttTestKey + "\nEVIL=1", Model: "m"},
			wantErr: "newline",
		},
		{
			name: "enabled with no url", config: "a: 1\n", withConfig: true, env: "A=1\n", withEnv: true,
			setting: HermesSTTSetting{Enabled: true, APIKey: sttTestKey, Model: "m"},
			wantErr: "url",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := sttProfile(t, tc.config, tc.withConfig, tc.env, tc.withEnv)
			err := WriteHermesSTT(dir, tc.setting)
			if err == nil {
				t.Fatal("want a refusal")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q should mention %q", err.Error(), tc.wantErr)
			}
			if strings.Contains(err.Error(), sttTestKey) {
				t.Errorf("error leaks the API key: %q", err.Error())
			}
			// Nothing written on a refusal.
			if tc.withEnv {
				if got := readFile(t, filepath.Join(dir, ".env")); got != tc.env {
					t.Errorf(".env changed on a refusal: %q", got)
				}
			}
			if tc.withConfig {
				if got := readFile(t, filepath.Join(dir, "config.yaml")); got != tc.config {
					t.Errorf("config.yaml changed on a refusal: %q", got)
				}
			}
		})
	}
}

// TestHermesSTTBaseURL pins the /v1 rule on its own.
func TestHermesSTTBaseURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://h:8840":        "http://h:8840/v1",
		"http://h:8840/":       "http://h:8840/v1",
		"http://h:8840//":      "http://h:8840/v1",
		"https://api.x/v1":     "https://api.x/v1",
		"https://api.x/v1/":    "https://api.x/v1",
		"https://api.x/openai": "https://api.x/openai/v1",
	} {
		if got := hermesSTTBaseURL(in); got != want {
			t.Errorf("hermesSTTBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
}
