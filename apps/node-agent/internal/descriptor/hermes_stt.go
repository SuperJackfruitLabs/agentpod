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

// HermesSTTSetting is the voice-note transcription setting a Hermes profile
// should run with, as the hub resolved it for one station.
//
// SECURITY: APIKey is written only into the profile's .env bytes. It never
// appears in a returned error.
type HermesSTTSetting struct {
	Enabled bool
	// URL is the service's base URL WITHOUT the OpenAI `/v1` path, the way the
	// hub stores it (e.g. http://100.78.52.87:8840). Hermes's OpenAI STT client
	// wants the `/v1` base; hermesSTTBaseURL adds it.
	URL    string
	APIKey string
	Model  string
}

// Env keys Hermes reads its OpenAI-compatible STT endpoint from.
const (
	hermesSTTBaseURLEnv = "STT_OPENAI_BASE_URL"
	hermesSTTKeyEnv     = "VOICE_TOOLS_OPENAI_KEY"
)

// WriteHermesSTT points a Hermes profile's own speech-to-text at the setting.
//
// Hermes reads STT from two places, and this writes both:
//
//	config.yaml   stt.enabled, stt.provider (openai), stt.openai.model
//	.env          STT_OPENAI_BASE_URL (<url>/v1), VOICE_TOOLS_OPENAI_KEY
//
// config.yaml is edited through the yaml.v3 node tree, so comments, key order
// and every setting outside `stt` survive; the result is re-parsed and
// compared against the original with `stt` removed, and a difference is a
// refusal rather than a write. .env lines are replaced in place (or appended
// when absent) with every other line byte-identical, exactly as
// hermesEnvWriter does for the Matrix credential.
//
// Disabled sets `stt.enabled: false` and leaves the rest of `stt` and all of
// .env alone: turning voice notes off must not throw away a working endpoint.
//
// Both files must already exist — a directory without them is not a Hermes
// profile this writer recognises. Everything is computed before anything is
// written, so every refusal leaves the profile untouched.
func WriteHermesSTT(profileDir string, s HermesSTTSetting) error {
	configPath := filepath.Join(profileDir, "config.yaml")
	envPath := filepath.Join(profileDir, ".env")

	configInfo, err := os.Stat(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("hermes: %s has no config.yaml; refusing to write an unrecognised profile", profileDir)
		}
		return fmt.Errorf("hermes: reading config.yaml: %w", err)
	}
	config, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("hermes: reading config.yaml: %w", err)
	}
	env, err := os.ReadFile(envPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("hermes: %s has no .env; refusing to write an unrecognised profile", profileDir)
		}
		return fmt.Errorf("hermes: reading .env: %w", err)
	}

	var newEnv []byte
	if s.Enabled {
		if strings.TrimSpace(s.URL) == "" {
			return errors.New("hermes: transcription is enabled but has no service url")
		}
		// A newline in a value would write a second .env line of the
		// caller's choosing. Refused without echoing the value.
		if strings.ContainsAny(s.URL, "\r\n") || strings.ContainsAny(s.APIKey, "\r\n") {
			return errors.New("hermes: transcription url or api key contains a newline; refusing to write it into .env")
		}
		newEnv = setEnvLines(env, []envSet{
			{hermesSTTBaseURLEnv, hermesSTTBaseURL(s.URL)},
			{hermesSTTKeyEnv, s.APIKey},
		})
	}

	newConfig, err := editHermesSTTConfig(config, s)
	if err != nil {
		return err
	}

	if newEnv != nil && !bytes.Equal(newEnv, env) {
		if err := atomicWriteFile(envPath, newEnv, 0o600); err != nil {
			return fmt.Errorf("hermes: writing .env: %w", err)
		}
	}
	if !bytes.Equal(newConfig, config) {
		if err := atomicWriteFile(configPath, newConfig, configInfo.Mode().Perm()); err != nil {
			return fmt.Errorf("hermes: writing config.yaml: %w", err)
		}
	}
	return nil
}

// WriteHermesTranscription is WriteHermesSTT in the shape the
// transcription.apply handler injects (gateway.TranscriptionWriteFunc).
func WriteHermesTranscription(profileDir string, cfg gateway.TranscriptionConfig) error {
	return WriteHermesSTT(profileDir, HermesSTTSetting{
		Enabled: cfg.Enabled, URL: cfg.URL, APIKey: cfg.APIKey, Model: cfg.Model,
	})
}

// hermesSTTBaseURL turns the hub's base URL into the `/v1` base Hermes's
// OpenAI STT client expects: trailing slashes trimmed, `/v1` appended unless
// it is already there.
func hermesSTTBaseURL(url string) string {
	u := strings.TrimRight(strings.TrimSpace(url), "/")
	if strings.HasSuffix(u, "/v1") {
		return u
	}
	return u + "/v1"
}

type envSet struct{ key, value string }

// setEnvLines replaces each key's line in a .env (keeping an `export `
// prefix) or appends it when absent. Every other line is byte-identical.
func setEnvLines(data []byte, sets []envSet) []byte {
	lines := strings.Split(string(data), "\n")
	seen := make([]bool, len(sets))
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		withoutExport := strings.TrimPrefix(trimmed, "export ")
		exportPrefix := ""
		if withoutExport != trimmed {
			exportPrefix = "export "
		}
		key, _, found := strings.Cut(withoutExport, "=")
		if !found {
			continue
		}
		for j, s := range sets {
			if strings.TrimSpace(key) == s.key {
				lines[i] = exportPrefix + s.key + "=" + s.value
				seen[j] = true
			}
		}
	}
	out := strings.Join(lines, "\n")
	for j, s := range sets {
		if seen[j] {
			continue
		}
		if out != "" && !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		out += s.key + "=" + s.value + "\n"
	}
	return []byte(out)
}

// editHermesSTTConfig returns config.yaml with its `stt` section set for s.
func editHermesSTTConfig(config []byte, s HermesSTTSetting) ([]byte, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(config, &doc); err != nil {
		return nil, fmt.Errorf("hermes: config.yaml is not valid YAML: %w", err)
	}
	if doc.Kind == 0 {
		// Empty (or comment-only) file: start a document of our own.
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("hermes: config.yaml is not a mapping; refusing to edit it")
	}
	root := doc.Content[0]

	stt := mappingChild(root, "stt")
	if stt == nil {
		return nil, errors.New("hermes: config.yaml's stt is not a mapping; refusing to edit it")
	}
	setScalar(stt, "enabled", "!!bool", fmt.Sprint(s.Enabled))
	if s.Enabled {
		setScalar(stt, "provider", "!!str", "openai")
		if s.Model != "" {
			openai := mappingChild(stt, "openai")
			if openai == nil {
				return nil, errors.New("hermes: config.yaml's stt.openai is not a mapping; refusing to edit it")
			}
			setScalar(openai, "model", "!!str", s.Model)
		}
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return nil, fmt.Errorf("hermes: encoding config.yaml: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("hermes: encoding config.yaml: %w", err)
	}
	out := buf.Bytes()

	// The edit may touch `stt` and nothing else. Re-parse both sides and
	// compare the rest — a re-encode that changed any other setting is a
	// refusal, not a write.
	if err := sameOutsideSTT(config, out); err != nil {
		return nil, err
	}
	return out, nil
}

// mappingChild returns parent[key] as a mapping, creating it when absent or
// empty (`stt:` with no value). It returns nil when the key holds something
// that is not a mapping.
func mappingChild(parent *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value != key {
			continue
		}
		v := parent.Content[i+1]
		switch {
		case v.Kind == yaml.MappingNode:
			return v
		case v.Kind == yaml.ScalarNode && (v.Tag == "!!null" || v.Value == ""):
			*v = yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", LineComment: v.LineComment}
			return v
		default:
			return nil
		}
	}
	m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	parent.Content = append(parent.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, m)
	return m
}

// setScalar sets parent[key] to a plain scalar, keeping any comment already
// on the value.
func setScalar(parent *yaml.Node, key, tag, value string) {
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value == key {
			v := parent.Content[i+1]
			*v = yaml.Node{
				Kind: yaml.ScalarNode, Tag: tag, Value: value,
				HeadComment: v.HeadComment, LineComment: v.LineComment, FootComment: v.FootComment,
			}
			return
		}
	}
	parent.Content = append(parent.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: value},
	)
}

func sameOutsideSTT(before, after []byte) error {
	var b, a map[string]any
	if err := yaml.Unmarshal(before, &b); err != nil {
		return fmt.Errorf("hermes: config.yaml is not valid YAML: %w", err)
	}
	if err := yaml.Unmarshal(after, &a); err != nil {
		return fmt.Errorf("hermes: the edited config.yaml does not parse: %w", err)
	}
	delete(b, "stt")
	delete(a, "stt")
	if len(b) == 0 && len(a) == 0 {
		return nil
	}
	if !reflect.DeepEqual(b, a) {
		return errors.New("hermes: editing config.yaml's stt section would change other settings; refusing to write it")
	}
	return nil
}
