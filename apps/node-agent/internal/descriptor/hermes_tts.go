package descriptor

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// HermesTTSSetting is the spoken-reply setting a Hermes profile should run
// with, as the hub resolved it for one station.
//
// SECURITY: APIKey is written only into the profile's .env bytes. It never
// appears in config.yaml or in a returned error.
type HermesTTSSetting struct {
	Enabled bool
	// URL is the speech service's base URL WITHOUT the OpenAI `/v1` path, the
	// way the hub stores it (e.g. http://100.78.52.87:8841).
	URL    string
	APIKey string
	// Voice is a Kokoro voice id, a blend (af_heart:60+af_bella:40) or an
	// OpenAI alias; the service resolves it.
	Voice string
	// SpeakMode is the hub's off | voice_in | always.
	SpeakMode string
}

const (
	// hermesTTSKeyEnv holds the speech service's key in the profile's .env.
	// Not VOICE_TOOLS_OPENAI_KEY: Hermes's OpenAI STT reads that one too
	// (tools/tool_backend_helpers.py resolve_openai_audio_api_key), and
	// transcription.apply writes the transcription service's key there — a
	// different service with, possibly, a different token.
	hermesTTSKeyEnv = "AGENTPOD_TTS_API_KEY"
	// hermesTTSKeyRef is what config.yaml's tts.openai.api_key holds. Hermes
	// expands ${VAR} in config values from the profile's own .env scope
	// (hermes_cli/config.py _expand_env_vars / _env_ref_lookup), and
	// tts.openai.api_key beats the env keys (tools/tts_tool_openai.py
	// _resolve_openai_audio_client_config), so the secret stays in .env.
	hermesTTSKeyRef = "${" + hermesTTSKeyEnv + "}"
	// hermesTTSModel is sent as the OpenAI `model`. The speech service has one
	// model and ignores the field (deploy/speech/server.py SpeechRequest);
	// naming it keeps Hermes off its gpt-4o-mini-tts default in logs.
	hermesTTSModel = "kokoro"
)

// The tts.openai keys this writer owns; anything else under tts.openai is the
// operator's and must survive.
var hermesTTSOpenAIKeys = []string{"base_url", "model", "voice", "api_key"}

// WriteHermesTTS points a Hermes profile's own text-to-speech at the setting
// and reports whether Hermes will speak every reply on its own afterwards
// (the profile's effective `voice.auto_tts`).
//
// Enabled writes:
//
//	config.yaml   tts.provider: openai
//	              tts.openai.{base_url: <url>/v1, model: kokoro, voice: <voice>,
//	                          api_key: ${AGENTPOD_TTS_API_KEY}}
//	              voice.auto_tts: true for `always`, false for `off`
//	.env          AGENTPOD_TTS_API_KEY=<key>
//
// `voice_in` has no Hermes profile setting — Hermes's "answer a voice note
// with a voice note" is the per-room `/voice on` (gateway/slash_commands.py
// _VOICE_MODE_BY_ARG → voice_only), and `voice.auto_tts: true` speaks every
// reply — so voice_in leaves voice.auto_tts as it is and the result says what
// that is.
//
// Every other key under `tts` — the operator's `providers.cloudflare-aura`
// command provider above all — is left alone, as is every other key under
// tts.openai. Hermes has no TTS fallback-provider list, so the old provider
// stays defined and one `tts.provider:` edit away.
//
// Disabled (no speech service for the station) sets voice.auto_tts false when
// it is on and leaves tts and .env alone: turning speech off must not throw
// away a working provider.
//
// The yaml.v3 node tree keeps comments, key order and every other setting;
// the result is re-parsed and compared with the original minus the keys above,
// and any other difference is a refusal. .env lines are replaced in place (or
// appended) with every other line byte-identical, written 0600 atomically.
// Everything is computed before anything is written, so every refusal leaves
// the profile untouched.
func WriteHermesTTS(profileDir string, s HermesTTSSetting) (autoSpeak bool, err error) {
	configPath := filepath.Join(profileDir, "config.yaml")
	envPath := filepath.Join(profileDir, ".env")

	configInfo, err := os.Stat(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, fmt.Errorf("hermes: %s has no config.yaml; refusing to write an unrecognised profile", profileDir)
		}
		return false, fmt.Errorf("hermes: reading config.yaml: %w", err)
	}
	config, err := os.ReadFile(configPath)
	if err != nil {
		return false, fmt.Errorf("hermes: reading config.yaml: %w", err)
	}
	env, err := os.ReadFile(envPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, fmt.Errorf("hermes: %s has no .env; refusing to write an unrecognised profile", profileDir)
		}
		return false, fmt.Errorf("hermes: reading .env: %w", err)
	}

	var newEnv []byte
	if s.Enabled {
		switch {
		case strings.TrimSpace(s.URL) == "":
			return false, errors.New("hermes: speech is enabled but has no service url")
		case strings.TrimSpace(s.Voice) == "":
			return false, errors.New("hermes: speech is enabled but has no voice")
		case s.SpeakMode != "off" && s.SpeakMode != "voice_in" && s.SpeakMode != "always":
			return false, fmt.Errorf("hermes: unknown speak mode %q", s.SpeakMode)
		}
		// A newline in a value would write a second .env line (or YAML) of
		// the caller's choosing. Refused without echoing the value.
		if strings.ContainsAny(s.URL, "\r\n") || strings.ContainsAny(s.APIKey, "\r\n") || strings.ContainsAny(s.Voice, "\r\n") {
			return false, errors.New("hermes: speech url, voice or api key contains a newline; refusing to write it")
		}
		newEnv = setEnvLines(env, []envSet{{hermesTTSKeyEnv, s.APIKey}})
	}

	newConfig, autoSpeak, err := editHermesTTSConfig(config, s)
	if err != nil {
		return false, err
	}

	if newEnv != nil && !bytes.Equal(newEnv, env) {
		if err := atomicWriteFile(envPath, newEnv, 0o600); err != nil {
			return false, fmt.Errorf("hermes: writing .env: %w", err)
		}
	}
	if !bytes.Equal(newConfig, config) {
		if err := atomicWriteFile(configPath, newConfig, configInfo.Mode().Perm()); err != nil {
			return false, fmt.Errorf("hermes: writing config.yaml: %w", err)
		}
	}
	return autoSpeak, nil
}

// WriteHermesSpeech is WriteHermesTTS in the shape the speech.apply handler
// injects (gateway.SpeechWriteFunc).
func WriteHermesSpeech(profileDir string, cfg gateway.SpeechConfig) (bool, error) {
	return WriteHermesTTS(profileDir, HermesTTSSetting{
		Enabled: cfg.Enabled, URL: cfg.URL, APIKey: cfg.APIKey, Voice: cfg.Voice, SpeakMode: cfg.SpeakMode,
	})
}

// editHermesTTSConfig returns config.yaml with its tts / voice.auto_tts set
// for s, and the effective voice.auto_tts afterwards.
func editHermesTTSConfig(config []byte, s HermesTTSSetting) ([]byte, bool, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(config, &doc); err != nil {
		return nil, false, fmt.Errorf("hermes: config.yaml is not valid YAML: %w", err)
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, false, errors.New("hermes: config.yaml is not a mapping; refusing to edit it")
	}
	root := doc.Content[0]

	// Refuse an unknown `voice` shape before anything else, on and off alike.
	if v := child(root, "voice"); v != nil && !isMappingOrEmpty(v) {
		return nil, false, errors.New("hermes: config.yaml's voice is not a mapping; refusing to edit it")
	}

	autoTTS := "" // "" = leave voice.auto_tts as it is
	if s.Enabled {
		tts := mappingChild(root, "tts")
		if tts == nil {
			return nil, false, errors.New("hermes: config.yaml's tts is not a mapping; refusing to edit it")
		}
		openai := mappingChild(tts, "openai")
		if openai == nil {
			return nil, false, errors.New("hermes: config.yaml's tts.openai is not a mapping; refusing to edit it")
		}
		setScalar(tts, "provider", "!!str", "openai")
		setScalar(openai, "base_url", "!!str", hermesSTTBaseURL(s.URL))
		setScalar(openai, "model", "!!str", hermesTTSModel)
		setScalar(openai, "voice", "!!str", strings.TrimSpace(s.Voice))
		setScalar(openai, "api_key", "!!str", hermesTTSKeyRef)
		switch s.SpeakMode {
		case "always":
			autoTTS = "true"
		case "off":
			autoTTS = "false"
		}
	} else {
		autoTTS = "false"
	}

	if autoTTS != "" {
		current := autoTTSOf(root)
		// Setting it false where it is absent would add a section to say what
		// Hermes already defaults to (hermes_cli config_defaults voice.auto_tts).
		if autoTTS == "true" || current {
			voice := mappingChild(root, "voice")
			setScalar(voice, "auto_tts", "!!bool", autoTTS)
		}
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return nil, false, fmt.Errorf("hermes: encoding config.yaml: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, false, fmt.Errorf("hermes: encoding config.yaml: %w", err)
	}
	out := buf.Bytes()
	if !bytes.Equal(out, config) {
		if err := sameOutsideTTS(config, out); err != nil {
			return nil, false, err
		}
	} else {
		out = config
	}
	return out, autoTTSOf(root), nil
}

func child(parent *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value == key {
			return parent.Content[i+1]
		}
	}
	return nil
}

func isMappingOrEmpty(v *yaml.Node) bool {
	return v.Kind == yaml.MappingNode || (v.Kind == yaml.ScalarNode && (v.Tag == "!!null" || v.Value == ""))
}

// autoTTSOf is the profile's voice.auto_tts as Hermes reads it: a YAML true,
// anything else (absent included) off.
func autoTTSOf(root *yaml.Node) bool {
	voice := child(root, "voice")
	if voice == nil || voice.Kind != yaml.MappingNode {
		return false
	}
	v := child(voice, "auto_tts")
	if v == nil || v.Kind != yaml.ScalarNode {
		return false
	}
	var b bool
	if err := v.Decode(&b); err != nil {
		return false
	}
	return b
}

// sameOutsideTTS refuses an edit that changed anything but tts.provider, the
// tts.openai keys this writer owns and voice.auto_tts. An empty map is the
// same as an absent one: `voice: {}` added and nothing in it is no change.
func sameOutsideTTS(before, after []byte) error {
	var b, a map[string]any
	if err := yaml.Unmarshal(before, &b); err != nil {
		return fmt.Errorf("hermes: config.yaml is not valid YAML: %w", err)
	}
	if err := yaml.Unmarshal(after, &a); err != nil {
		return fmt.Errorf("hermes: the edited config.yaml does not parse: %w", err)
	}
	strip := func(m map[string]any) map[string]any {
		if m == nil {
			m = map[string]any{}
		}
		if tts, ok := m["tts"].(map[string]any); ok {
			delete(tts, "provider")
			if openai, ok := tts["openai"].(map[string]any); ok {
				for _, k := range hermesTTSOpenAIKeys {
					delete(openai, k)
				}
				if len(openai) == 0 {
					delete(tts, "openai")
				}
			}
			if len(tts) == 0 {
				delete(m, "tts")
			}
		}
		if voice, ok := m["voice"].(map[string]any); ok {
			delete(voice, "auto_tts")
			if len(voice) == 0 {
				delete(m, "voice")
			}
		}
		for _, k := range []string{"tts", "voice"} {
			if v, ok := m[k]; ok && v == nil {
				delete(m, k)
			}
		}
		return m
	}
	if !reflect.DeepEqual(strip(b), strip(a)) {
		return errors.New("hermes: editing config.yaml's tts section would change other settings; refusing to write it")
	}
	return nil
}
