package descriptor

import (
	"strings"
	"testing"
)

// Every harness AgentPod ships now implements ACPCommander, so "unsupported" is
// no longer reachable through a real descriptor — the coverage still matters
// though: the interface is optional by contract, and a future harness (or an
// out-of-tree one) that omits it must get this error rather than a nil-interface
// panic. fakeDescriptor is exactly such a descriptor.
func TestHandlerACPCommand_UnsupportedHarness(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "no-acp-harness"})
	if _, ok := any(&fakeDescriptor{}).(ACPCommander); ok {
		t.Fatal("fakeDescriptor must NOT implement ACPCommander for this test to mean anything")
	}
	h := NewCapabilityHandler(reg)

	_, _, _, err := h.ACPCommand("no-acp-harness:s1")
	if err == nil {
		t.Fatal("expected error for harness without ACP support")
	}
	if !strings.Contains(err.Error(), "acp not supported") {
		t.Errorf("error should contain %q, got: %v", "acp not supported", err)
	}
}

func TestHandlerACPCommand_UnknownHarness(t *testing.T) {
	h := NewCapabilityHandler(NewRegistry())
	if _, _, _, err := h.ACPCommand("hermes:coder-kai"); err == nil {
		t.Fatal("expected error for unregistered harness")
	}
}
