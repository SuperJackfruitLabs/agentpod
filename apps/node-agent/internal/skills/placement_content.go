package skills

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"
)

// Stored archives may contain future native extensions, but this publication
// adapter covers plain skills only. It never turns an extension-bearing package
// into active hooks, tool servers, dependencies or executable plugin entrypoints.
func (s *InstallStore) placementContent(ctx context.Context, g *Generation, m *BundleManifest) error {
	if g == nil {
		return nil
	}
	declared := map[string]bool{}
	for _, skill := range m.Skills {
		declared[skill.ID] = true
	}
	for name := range m.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		parts := strings.Split(name, "/")
		if parts[0] == "skills" && len(parts) >= 3 && declared[parts[1]] {
			if path.Base(name) == "SKILL.md" && len(parts) != 3 {
				return fmt.Errorf("skills: undeclared nested skill entrypoint")
			}
			continue
		}
		if parts[0] == "notices" && len(parts) >= 2 {
			continue
		}
		if name == "sjl-adapter.json" || name == "sjl-sources.json" {
			continue
		}
		allowed := map[string]bool{"name": true, "version": true, "description": true, "author": true}
		switch {
		case name == "plugin.json" && (s.binding.Harness == "codex" || s.binding.Harness == "openclaw"):
			allowed["$schema"] = true
		// Claude exports carry a plugin manifest because that is how the
		// bundle is built. It is validated here and never published: the
		// direct projection copies only the skill directory, so nothing
		// under .claude-plugin reaches the discovery root. No key beyond the
		// descriptive set is allowed, so a manifest declaring hooks, MCP
		// servers, commands or agents is refused rather than quietly placed.
		case name == ".claude-plugin/plugin.json" && s.binding.Harness == "claude-code":
		case name == ".codex-plugin/plugin.json" && s.binding.Harness == "codex":
			allowed["skills"] = true
			allowed["interface"] = true
		case name == "package.json" && s.binding.Harness == "pi":
			allowed = map[string]bool{"name": true, "version": true, "description": true, "private": true, "pi": true}
		default:
			return fmt.Errorf("skills: native publication does not support component %s", name)
		}
		data, err := readManaged(s.root, "generations/"+g.Generation+"/"+name, 2<<20)
		if err != nil {
			return err
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.UseNumber()
		value, err := uniqueJSON(decoder, 0)
		if err != nil {
			return err
		}
		if _, err = decoder.Token(); err != io.EOF {
			return fmt.Errorf("skills: trailing native manifest data")
		}
		manifest, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("skills: invalid native manifest")
		}
		for key := range manifest {
			if !allowed[key] {
				return fmt.Errorf("skills: native executable or unsupported manifest component %s", key)
			}
		}
		if manifest["name"] != m.Name || manifest["version"] != m.Version {
			return fmt.Errorf("skills: native manifest identity differs")
		}
		if name == ".codex-plugin/plugin.json" {
			if manifest["skills"] != "./skills/" {
				return fmt.Errorf("skills: native skill root is not local")
			}
			if metadata, exists := manifest["interface"]; exists {
				object, ok := metadata.(map[string]any)
				if !ok {
					return fmt.Errorf("skills: invalid native interface metadata")
				}
				for key, value := range object {
					switch key {
					case "displayName", "shortDescription", "longDescription", "developerName", "category":
						if _, ok := value.(string); !ok {
							return fmt.Errorf("skills: invalid native display metadata")
						}
					case "capabilities":
						if !exactStrings(value) {
							return fmt.Errorf("skills: native capability grants are unsupported")
						}
					case "defaultPrompt":
						list, ok := value.([]any)
						if !ok {
							return fmt.Errorf("skills: invalid native prompts")
						}
						for _, prompt := range list {
							if _, ok := prompt.(string); !ok {
								return fmt.Errorf("skills: invalid native prompt")
							}
						}
					default:
						return fmt.Errorf("skills: unsupported native interface metadata")
					}
				}
			}
		}
		if name == "package.json" {
			resources, ok := manifest["pi"].(map[string]any)
			if !ok || !exactStrings(resources["skills"], "./skills") {
				return fmt.Errorf("skills: native Pi skill root is not local")
			}
			for key, value := range resources {
				if key == "skills" {
					continue
				}
				if (key != "extensions" && key != "prompts" && key != "themes") || !exactStrings(value) {
					return fmt.Errorf("skills: native Pi extensions or resources are unsupported")
				}
			}
		}
	}
	return nil
}
func exactStrings(value any, expected ...string) bool {
	list, ok := value.([]any)
	if !ok || len(list) != len(expected) {
		return false
	}
	for i, want := range expected {
		if list[i] != want {
			return false
		}
	}
	return true
}
