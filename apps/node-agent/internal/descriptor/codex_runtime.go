package descriptor

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// These diagnostics describe selection for a NEW session, not the engine of an
// already running process. Read package metadata without launching/installing
// software on the health polling path. Standalone adapters may have no metadata.
func (c *codexDescriptor) chatRuntimeNote() string {
	adapter, ok := c.locator().locate(codexACPBinaryName, c.acpBinary)
	if !ok {
		return "Next chat: " + codexACPPackage + " via npx; bundled Codex version unverified until installed"
	}
	return codexRuntimeNote(adapter, c.codexBinary)
}

func packageVersion(path, name string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	var p struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if json.NewDecoder(io.LimitReader(f, 64*1024)).Decode(&p) != nil || p.Name != name {
		return ""
	}
	return p.Version
}

func codexRuntimeNote(adapter, override string) string {
	note := "Next chat: adapter " + adapter
	resolved, err := filepath.EvalSymlinks(adapter)
	var root, version string
	if err == nil {
		for dir, n := filepath.Dir(resolved), 0; n < 12; n++ {
			if v := packageVersion(filepath.Join(dir, "package.json"), "@agentclientprotocol/codex-acp"); v != "" {
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
				engine = packageVersion(filepath.Join(dir, "node_modules", "@openai", "codex", "package.json"), "@openai/codex")
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
