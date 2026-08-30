package descriptor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMatrixIDFromProfile(t *testing.T) {
	dir := t.TempDir()
	// auth.json holds user_id + a token; we must extract ONLY user_id.
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"user_id":"@analyst-echo:id.agentpod.dev","access_token":"SECRET"}`), 0600); err != nil {
		t.Fatalf("write auth.json: %v", err)
	}
	got := MatrixIDFromProfile(dir, "id.agentpod.dev")
	if got == nil || *got != "@analyst-echo:id.agentpod.dev" {
		t.Fatalf("want mxid, got %v", got)
	}
	// a profile with no matrix config → nil
	if MatrixIDFromProfile(t.TempDir(), "id.agentpod.dev") != nil {
		t.Fatal("want nil for no-matrix profile")
	}
}

func TestMatrixIDNeverReturnsToken(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"user_id":"@x:id.agentpod.dev","access_token":"SECRET-TOKEN"}`), 0600); err != nil {
		t.Fatalf("write auth.json: %v", err)
	}
	got := MatrixIDFromProfile(dir, "id.agentpod.dev")
	if got == nil || strings.Contains(*got, "SECRET") {
		t.Fatalf("token leaked: %v", got)
	}
}

func TestMatrixIDInvalidShape(t *testing.T) {
	dir := t.TempDir()
	// user_id that is NOT mxid-shaped → nil
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"user_id":"foo","access_token":"SECRET"}`), 0600); err != nil {
		t.Fatalf("write auth.json: %v", err)
	}
	got := MatrixIDFromProfile(dir, "id.agentpod.dev")
	if got != nil {
		t.Fatalf("want nil for invalid mxid shape, got %v", got)
	}
}

func TestMatrixIDFromConfigYAML(t *testing.T) {
	dir := t.TempDir()
	// No auth.json, but config.yaml has a user_id field.
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("user_id: \"@bot:id.agentpod.dev\"\nsome_other: value\n"), 0600); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
	got := MatrixIDFromProfile(dir, "id.agentpod.dev")
	if got == nil || *got != "@bot:id.agentpod.dev" {
		t.Fatalf("want mxid from config.yaml, got %v", got)
	}
}

// TestMatrixIDIgnoresNestedUserID is the regression for a real incident.
//
// A Hermes profile with a home channel carries a `user_id` naming the human
// counterpart of that DM. The parser matched `user_id:` at any indentation and
// reported it as the STATION's own identity, so:
//
//   - the operator's mxid was claimed by both a principal and a station, which
//     made `resolveMatrixId` ambiguous and meant nothing they sent could be
//     attributed — approving a gate from their phone was silently refused
//   - the agent's messages were attributable to the operator
//   - fleet liveness checked the operator's phone to decide whether the agent
//     was alive, and reported the fleet fully healthy throughout
//
// Correcting the database did not hold: the node re-reports on every adoption,
// so the row was rewritten within minutes. The config is the source.
func TestMatrixIDIgnoresNestedUserID(t *testing.T) {
	dir := t.TempDir()
	const cfg = `_config_version: 37
platforms:
  matrix:
    enabled: true
    home_channel:
      platform: matrix
      chat_id: '!6HOezBXFk71L5hqwm9:id.agentpod.dev'
      name: writer-quill
      user_id: '@rakesh:id.agentpod.dev'
      scope_id: id.agentpod.dev
`
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(cfg), 0600); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
	if got := MatrixIDFromProfile(dir, "id.agentpod.dev"); got != nil {
		t.Fatalf("a home channel's user_id is the human it talks to, not this station: got %q", *got)
	}
}

// TestMatrixIDFromMatrixSection keeps the case the fix must not break.
func TestMatrixIDFromMatrixSection(t *testing.T) {
	dir := t.TempDir()
	const cfg = `platforms:
  matrix:
    enabled: true
    user_id: '@agent_guild_hermes-writer-quill:id.agentpod.dev'
    home_channel:
      user_id: '@rakesh:id.agentpod.dev'
`
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(cfg), 0600); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
	got := MatrixIDFromProfile(dir, "id.agentpod.dev")
	if got == nil || *got != "@agent_guild_hermes-writer-quill:id.agentpod.dev" {
		t.Fatalf("an immediate child of matrix: is the station's own identity, got %v", got)
	}
}

// TestMatrixIDPrefersEnvOverNestedNoise is the shape the live fleet was in:
// no usable id in config.yaml, the right one in .env.
func TestMatrixIDPrefersEnvOverNestedNoise(t *testing.T) {
	dir := t.TempDir()
	const cfg = `platforms:
  matrix:
    enabled: true
    home_channel:
      user_id: '@rakesh:id.agentpod.dev'
`
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(cfg), 0600); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
	env := "MATRIX_USER_ID=@agent_guild_hermes-writer-quill:id.agentpod.dev\nMATRIX_ACCESS_TOKEN=secret\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0600); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	got := MatrixIDFromProfile(dir, "id.agentpod.dev")
	if got == nil || *got != "@agent_guild_hermes-writer-quill:id.agentpod.dev" {
		t.Fatalf("want the .env identity once config.yaml offers nothing usable, got %v", got)
	}
}
