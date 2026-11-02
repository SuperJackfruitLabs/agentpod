package descriptor

import (
	"context"
	"encoding/json"
	"testing"
)

func TestSkillInventoryUnsupportedDescriptorDoesNotFallbackToFiles(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})
	_, _, err := NewHandler(reg).Handle(context.Background(), "skills.inventory", json.RawMessage(`{"key":"fake:station"}`), nil)
	if err == nil {
		t.Fatal("unsupported descriptor accepted inventory")
	}
}
