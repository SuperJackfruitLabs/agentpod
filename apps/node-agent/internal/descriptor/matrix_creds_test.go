package descriptor

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func writeEnv(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestMatrixCredentialsFromEnvReadsTheThreeKeys(t *testing.T) {
	dir := writeEnv(t, strings.Join([]string{
		"# hermes profile",
		"OPENROUTER_API_KEY=sk-or-unrelated",
		`MATRIX_HOMESERVER="https://id.agentpod.dev/"`,
		"export MATRIX_USER_ID=@agent_coder-kai:id.agentpod.dev",
		"MATRIX_ACCESS_TOKEN='syt_secret'",
		"MATRIX_RECOVERY_KEY=EsT0 aBcD",
	}, "\n"))

	got, err := MatrixCredentialsFromEnv(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := MatrixCredentials{
		Homeserver:  "https://id.agentpod.dev",
		UserID:      "@agent_coder-kai:id.agentpod.dev",
		AccessToken: "syt_secret",
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMatrixCredentialsFromEnvRefusesAnIncompleteLogin(t *testing.T) {
	for name, body := range map[string]string{
		"no token":      "MATRIX_HOMESERVER=https://h\nMATRIX_USER_ID=@a:h\n",
		"no homeserver": "MATRIX_USER_ID=@a:h\nMATRIX_ACCESS_TOKEN=syt_secret\n",
		"bad mxid":      "MATRIX_HOMESERVER=https://h\nMATRIX_USER_ID=agent\nMATRIX_ACCESS_TOKEN=syt_secret\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := MatrixCredentialsFromEnv(writeEnv(t, body))
			if !errors.Is(err, ErrNoMatrixCredentials) {
				t.Fatalf("err = %v, want ErrNoMatrixCredentials", err)
			}
			if strings.Contains(err.Error(), "syt_secret") {
				t.Fatalf("error leaks the token: %v", err)
			}
		})
	}
}

func TestMatrixCredentialsFromEnvWithNoEnvFile(t *testing.T) {
	_, err := MatrixCredentialsFromEnv(t.TempDir())
	if !errors.Is(err, ErrNoMatrixCredentials) {
		t.Fatalf("err = %v, want ErrNoMatrixCredentials", err)
	}
}

func TestHermesDetectAdvertisesMatrixAvatarOnlyWithAnIdentity(t *testing.T) {
	home := defaultProfileHome(t)
	if err := os.MkdirAll(filepath.Join(home, "profiles", "no-matrix"), 0o755); err != nil {
		t.Fatal(err)
	}

	stations, err := NewHermes(home).Detect()
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"hermes", "hermes:analyst-echo", "hermes:buddhimaan"} {
		if s := findStation(t, stations, key); !slices.Contains(s.Capabilities, "matrix.avatar") {
			t.Errorf("%s has a Matrix identity but no matrix.avatar; caps = %v", key, s.Capabilities)
		}
	}
	if s := findStation(t, stations, "hermes:no-matrix"); slices.Contains(s.Capabilities, "matrix.avatar") {
		t.Errorf("a profile with no Matrix identity must not advertise matrix.avatar; caps = %v", s.Capabilities)
	}
}
