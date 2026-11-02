package openclaw

import (
	"testing"
)

// --- openclawDescriptor lifecycle ---

func TestOpenClawLifecycle_StartNoCommand_ReturnsError(t *testing.T) {
	o := &Descriptor{home: t.TempDir()}
	err := o.Start("openclaw")
	if err == nil {
		t.Fatal("expected error when startCmd is empty")
	}
}
