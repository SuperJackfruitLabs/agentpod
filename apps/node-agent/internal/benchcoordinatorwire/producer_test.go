package benchcoordinatorwire

import (
	"encoding/json"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

// The wire digest must match the actual producer's declared Go projection,
// not merely a second independently implemented encoder in this package.
func TestBindingMatchesActualProducer(t *testing.T) {
	c := corpus(t)
	var b benchdispatch.SourceBinding
	if err := json.Unmarshal([]byte(c.BindingCanonical), &b); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(b)
	if err != nil || string(raw) != c.BindingCanonical {
		t.Fatal("producer binding bytes differ")
	}
	if benchdispatch.SourceBindingSHA256(b) != c.BindingSHA256 {
		t.Fatal("producer binding digest differs")
	}
}
