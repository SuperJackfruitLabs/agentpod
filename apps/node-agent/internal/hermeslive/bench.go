package hermeslive

import (
	"fmt"
	"os"
	"path/filepath"
)

// BenchMinVersion is the first plugin version with the remote-bench hooks: replace-mode patch
// rewritten into V4A, and the bench note in each session's prompt.
const BenchMinVersion = "0.3.0"

// BenchReady says whether the profile's plugin can carry a remote-bench attachment: installed at
// BenchMinVersion or later, and enabled in config.yaml. Without it, every replace-mode patch on the
// bench is denied by edit approval. nil means ready; the error says what is missing.
func BenchReady(profileDir string) error {
	data, err := os.ReadFile(filepath.Join(pluginDir(profileDir), "plugin.yaml"))
	if err != nil {
		return fmt.Errorf("%s is not installed in this profile (apn hermes-live enable)", Name)
	}
	m, err := ParseManifest(data)
	if err != nil || m.Name != Name {
		return fmt.Errorf("the profile's %s plugin.yaml does not parse", Name)
	}
	ok, err := satisfies(">="+BenchMinVersion, m.Version)
	if err != nil || !ok {
		return fmt.Errorf("%s %s is installed; a remote bench needs %s or later (apn hermes-live enable)", Name, m.Version, BenchMinVersion)
	}
	if enabled := enabledObservation(profileDir, ""); enabled.Value == nil || !*enabled.Value {
		return fmt.Errorf("%s is installed but not enabled: %s", Name, enabled.Reason)
	}
	return nil
}
