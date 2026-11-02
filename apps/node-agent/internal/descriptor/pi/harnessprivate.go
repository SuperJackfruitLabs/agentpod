package pi

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// HarnessPrivate implements HarnessPrivate for Pi.
func (p *Descriptor) HarnessPrivate(key string) []string {
	return descriptor.PrivateIfHome(p.workspaceForKey(key))
}
