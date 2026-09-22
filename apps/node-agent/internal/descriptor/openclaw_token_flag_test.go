package descriptor

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openClawWithHelp(t *testing.T, help string, err error) (*openclawDescriptor, string) {
	t.Helper()
	home := t.TempDir()
	if mkErr := os.MkdirAll(filepath.Join(home, "workspace"), 0o755); mkErr != nil {
		t.Fatal(mkErr)
	}
	tokenFile := filepath.Join(t.TempDir(), "token")
	if wErr := os.WriteFile(tokenFile, []byte("secret-token"), 0o600); wErr != nil {
		t.Fatal(wErr)
	}
	d := NewOpenClawFrom(OpenClawConfig{Home: home, TokenFile: tokenFile, GatewayURL: "ws://127.0.0.1:18999"}).(*openclawDescriptor)
	d.resolveBinary = func() (string, error) { return "/test/openclaw", nil }
	d.gatewayUp = func() bool { return true }
	d.acpHelp = func(string) (string, error) { return help, err }
	return d, tokenFile
}

// A build that accepts --token-file gets it, and the token stays out of argv.
func TestOpenClawACPUsesTokenFileWhenTheBuildAcceptsIt(t *testing.T) {
	d, tokenFile := openClawWithHelp(t, "Options:\n  --token <token>\n  --token-file <path>\n", nil)
	argv, _, _, err := d.ACPCommand("openclaw:main")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(argv, " ")
	if !strings.Contains(joined, "--token-file "+tokenFile) {
		t.Fatalf("token file not passed: %v", argv)
	}
	if strings.Contains(joined, "secret-token") {
		t.Fatalf("the token itself reached argv: %v", argv)
	}
}

// A build without the flag is refused. Falling back to --token would put the
// gateway token where any process can read it, to make a session start.
func TestOpenClawACPRefusesABuildWithoutTokenFile(t *testing.T) {
	d, _ := openClawWithHelp(t, "Options:\n  --token <token>\n  --url <url>\n", nil)
	argv, _, _, err := d.ACPCommand("openclaw:main")
	if err == nil {
		t.Fatalf("a build without --token-file was accepted: %v", argv)
	}
	if !strings.Contains(err.Error(), "--token-file") || !strings.Contains(err.Error(), "command line") {
		t.Fatalf("the refusal does not explain itself: %v", err)
	}
	for _, arg := range argv {
		if strings.Contains(arg, "secret-token") {
			t.Fatal("the token reached argv on the refused path")
		}
	}
}

// An unreadable help is unknown, not permission to guess.
func TestOpenClawACPRefusesWhenTheBuildCannotBeAsked(t *testing.T) {
	d, _ := openClawWithHelp(t, "", errors.New("exec failed"))
	if _, _, _, err := d.ACPCommand("openclaw:main"); err == nil {
		t.Fatal("an unreadable help was treated as support")
	}
}

// With no token configured there is nothing to protect, so the build is not
// interrogated and the session is not blocked on it.
func TestOpenClawACPDoesNotAskAboutTokensWhenThereIsNone(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	d := NewOpenClawFrom(OpenClawConfig{Home: home, GatewayURL: "ws://127.0.0.1:18999"}).(*openclawDescriptor)
	d.resolveBinary = func() (string, error) { return "/test/openclaw", nil }
	d.gatewayUp = func() bool { return true }
	d.acpHelp = func(string) (string, error) {
		t.Fatal("the build was interrogated with no token configured")
		return "", nil
	}
	if _, _, _, err := d.ACPCommand("openclaw:main"); err != nil {
		t.Fatal(err)
	}
}
