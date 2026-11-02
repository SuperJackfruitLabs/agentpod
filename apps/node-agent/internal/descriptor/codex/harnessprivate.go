package codex

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// HarnessPrivate implements HarnessPrivate for Codex.
func (c *Descriptor) HarnessPrivate(key string) []string {
	return descriptor.PrivateIfHome(c.projectPathForKey(key))
}
