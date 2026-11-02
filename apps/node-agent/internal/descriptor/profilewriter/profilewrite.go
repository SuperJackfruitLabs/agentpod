package profilewriter

import (
	"sort"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hermes"
)

// writers holds every registered ProfileWriter, keyed by harness name.
var writers = map[string]descriptor.ProfileWriter{}

// registerWriter adds w to the registry, keyed by w.Harness().
func registerWriter(w descriptor.ProfileWriter) {
	writers[w.Harness()] = w
}

func init() {
	registerWriter(hermes.HermesEnvWriter{})
}

// WriterFor returns the registered ProfileWriter for harness, if any.
func WriterFor(harness string) (descriptor.ProfileWriter, bool) {
	w, ok := writers[harness]
	return w, ok
}

// AllWriters returns every registered writer, sorted by harness name for a
// deterministic order. The conformance suite ranges over this, so an adapter
// registered in a later slice is covered without the suite being edited.
func AllWriters() []descriptor.ProfileWriter {
	names := make([]string, 0, len(writers))
	for name := range writers {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]descriptor.ProfileWriter, 0, len(names))
	for _, name := range names {
		out = append(out, writers[name])
	}
	return out
}
