package benchidentity

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureKeyCreatesOnceAndKeepsPrivateKeyLocal(t *testing.T) {
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("ssh-keygen not installed")
	}
	root := t.TempDir()
	pub, keyPath, created, err := EnsureKey(root, "st_remote1", "hermes:coder")
	if err != nil || !created {
		t.Fatalf("EnsureKey = created %v, %v", created, err)
	}
	if keyPath != filepath.Join(root, "bench-identities", "st_remote1") {
		t.Fatalf("key path %s is not in the bench directory", keyPath)
	}
	// The reply is one public line and nothing private.
	if !strings.HasPrefix(pub, "ssh-ed25519 ") || strings.Contains(pub, "\n") || strings.Contains(pub, "PRIVATE") {
		t.Fatalf("public key = %q", pub)
	}
	for path, want := range map[string]os.FileMode{keyPath: 0o600, Dir(root): 0o700} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Errorf("%s mode = %v (%v), want %v", path, info.Mode().Perm(), err, want)
		}
	}
	private, _ := os.ReadFile(keyPath)

	again, againPath, created, err := EnsureKey(root, "st_remote1", "hermes:coder")
	if err != nil || created || again != pub || againPath != keyPath {
		t.Fatalf("second EnsureKey = %q %v %v", again, created, err)
	}
	if now, _ := os.ReadFile(keyPath); string(now) != string(private) {
		t.Fatal("a second ensure replaced the private key")
	}
	if CertPath(keyPath) != keyPath+"-cert.pub" {
		t.Errorf("CertPath = %s", CertPath(keyPath))
	}
	// Its own directory: the git identity's is never touched.
	if _, err := os.Stat(filepath.Join(root, "git-identities")); !os.IsNotExist(err) {
		t.Error("a bench key created the git identity directory")
	}
	if _, _, _, err := EnsureKey(root, "../escape", "hermes:coder"); err == nil {
		t.Error("an id that climbs out of the directory was accepted")
	}
}
