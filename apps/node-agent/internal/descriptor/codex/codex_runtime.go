package codex

import (
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostproc"
)

// These diagnostics describe selection for a NEW session, not the engine of an
// already running process. Read package metadata without launching/installing
// software on the health polling path. Standalone adapters may have no metadata.
func (c *Descriptor) chatRuntimeNote() string {
	adapter, ok := c.locator().Locate(codexACPBinaryName, c.acpBinary)
	if !ok {
		return "Next chat: " + codexACPPackage + " via npx; bundled Codex version unverified until installed"
	}
	return codexRuntimeNote(adapter, c.codexBinary)
}

func codexRuntimeNote(adapter, override string) string {
	note := "Next chat: adapter " + adapter
	resolved, err := filepath.EvalSymlinks(adapter)
	var root, version string
	if err == nil {
		for dir, n := filepath.Dir(resolved), 0; n < 12; n++ {
			if v := hostproc.PackageVersion(filepath.Join(dir, "package.json"), "@agentclientprotocol/codex-acp"); v != "" {
				root, version = dir, v
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	if version != "" {
		note += " (" + version + ")"
	}
	if override != "" {
		note += "; configured Codex " + override
	} else {
		engine := ""
		if root != "" {
			for dir, n := root, 0; n < 12; n++ {
				engine = hostproc.PackageVersion(filepath.Join(dir, "node_modules", "@openai", "codex", "package.json"), "@openai/codex")
				if engine != "" {
					break
				}
				parent := filepath.Dir(dir)
				if parent == dir {
					break
				}
				dir = parent
			}
		}
		if engine == "" {
			note += "; bundled Codex version unknown"
		} else {
			note += "; bundled Codex " + engine
		}
	}
	if version == "1.1.14" && override == "" {
		note += ". This adapter bundles an older engine; update to " + codexACPPackage + " for newer models. Updating the node alone does not update installed adapters."
	}
	return note
}
