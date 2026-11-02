package pi

import (
	"os"
	"testing"
	"time"
)

// TestMain lets this test binary act as its own "claude" stub: when
// re-exec'd with CLAUDE_STUB_SLEEP set it just sleeps. Copying /bin/sleep is
// not an option — macOS SIGKILLs relocated platform binaries (trust cache),
// and a shell script's process name is "sh", invisible to pgrep '^claude'.
func TestMain(m *testing.M) {
	if os.Getenv("CLAUDE_STUB_SLEEP") != "" {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	os.Exit(m.Run())
}
