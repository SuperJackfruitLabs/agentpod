package opencode

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// HarnessPrivate implements HarnessPrivate for OpenCode.
func (o *Descriptor) HarnessPrivate(key string) []string {
	return descriptor.PrivateIfHome(o.projectPathForKey(key))
}
