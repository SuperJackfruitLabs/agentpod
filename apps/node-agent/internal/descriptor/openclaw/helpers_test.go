package openclaw

import (
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// waitForHealthDiskBytes polls a descriptor's Health until the async disk
// cache populates DiskBytes, then returns it. Used by descriptor Health tests
// since DiskBytes is nil until the first background walk completes.
func waitForHealthDiskBytes(t *testing.T, get func() (descriptor.Health, error)) int64 {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h, err := get()
		if err != nil {
			t.Fatalf("Health: %v", err)
		}
		if h.DiskBytes != nil {
			return *h.DiskBytes
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Health.DiskBytes never populated within 2s")
	return 0
}
