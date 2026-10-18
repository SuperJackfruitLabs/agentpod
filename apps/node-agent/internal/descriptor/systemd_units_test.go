package descriptor

import (
	"path/filepath"
	"testing"
)

func TestOnlyAPerProfileHermesKeyNamesAUserUnit(t *testing.T) {
	for key, want := range map[string]string{
		"hermes:press":        "hermes-gateway-press.service",
		"hermes:analyst-echo": "hermes-gateway-analyst-echo.service",
		"hermes":              "", // the root gateway may serve several stations
		"hermes:":             "",
		"hermes:../x":         "",
		"hermes:a b":          "",
		"openclaw":            "", // one gateway for every agent
		"claude-code:work":    "",
	} {
		if got := hermesProfileUnit(key); got != want {
			t.Errorf("hermesProfileUnit(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestUserUnitDropInDirFollowsXDGConfigHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/cfg")
	if got, want := UserUnitDropInDir("u.service"), filepath.Join("/cfg", "systemd", "user", "u.service.d"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
