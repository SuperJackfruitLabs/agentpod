package gateway

import (
	"encoding/json"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/acp"
)

// TestProductionHandlerChainPreservesTerminalFrames exercises the decorator
// order assembled in cmd/agentpod-node/run.go. A terminal attach uses request
// frames and can therefore work even if a newer request-only wrapper erases
// FrameHandler; this test sends a later input frame through every wrapper.
func TestProductionHandlerChainPreservesTerminalFrames(t *testing.T) {
	inner := &frameRecorder{}
	var h Handler = inner
	h = NewSkillManagementHandler(h, SkillManagementDeps{})
	h = NewMatrixAdoptHandler(h, MatrixAdoptDeps{})
	h = NewChangesetHandler(h, WorkspaceFunc(func(string) (string, error) {
		t.Fatal("workspace lookup must not run for a terminal frame")
		return "", nil
	}))
	h = NewPostureHandler(h, func() int { return 0 })
	mgr := acp.NewManager()
	t.Cleanup(mgr.Shutdown)
	h = NewACPHandler(h, mgr, nil)
	h = NewUpdateHandler(h, "v0.1.37")

	fh, ok := h.(FrameHandler)
	if !ok {
		t.Fatal("production handler chain must implement FrameHandler for terminal input")
	}
	if err := fh.HandleFrame("input", "terminal-attach-1", json.RawMessage(`{"data":"aGk="}`)); err != nil {
		t.Fatalf("HandleFrame: %v", err)
	}
	if inner.gotType != "input" || inner.gotID != "terminal-attach-1" {
		t.Fatalf("inner frame = %q:%q, want input:terminal-attach-1", inner.gotType, inner.gotID)
	}
}
