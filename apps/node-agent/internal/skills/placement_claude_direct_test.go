package skills

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Claude export is a separate reviewed fixture. Installing the Codex one
// under a Claude binding is refused on bundle identity, which is the contract
// working rather than an obstacle to route around.
func claudeFixtureArchive(t *testing.T) ([]byte, string) {
	t.Helper()
	data, err := os.ReadFile("testdata/export-claude-code.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := os.ReadFile("testdata/exports.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct{ Harness, ArchiveSHA256, BundleDigest string }
	if err := json.Unmarshal(metadata, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		if fixture.Harness == "claude-code" {
			return data, fixture.ArchiveSHA256
		}
	}
	t.Fatal("no claude-code export fixture")
	return nil, ""
}

// Claude reads .claude/skills the way Codex reads .agents/skills: each
// immediate child is a skill directory holding SKILL.md. A probe against
// claude-agent-acp confirmed a session advertises a skill published there and
// does not advertise the grouped layout, so Claude publishes the direct one.
// The harness is part of the install namespace identity, so a Claude store is
// opened as Claude rather than switched after its generation is owned.
func claudePlacementStore(t *testing.T) *InstallStore {
	t.Helper()
	binding := InstallBinding{NodeID: "fixture-node", StationKey: "claude-code:fixture", Harness: "claude-code", Profile: "fixture", WorkspacePath: t.TempDir()}
	store, err := OpenInstallStore(binding)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if err := os.Mkdir(filepath.Join(store.binding.WorkspacePath, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	data, pin := claudeFixtureArchive(t)
	if _, err := store.PlanInstall(context.Background(), id, bytes.NewReader(data), pin); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(context.Background(), id, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	return store
}

func TestClaudePlacementPublishesTheDirectDiscoveryLayout(t *testing.T) {
	s := claudePlacementStore(t)
	ctx := context.Background()

	target, err := s.placementTarget()
	if err != nil {
		t.Fatal(err)
	}
	if target != ".claude/skills/sjl-"+s.binding.Profile {
		t.Fatalf("claude destination is not the native discovery root: %q", target)
	}

	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if p.NativeLayout != claudeDirectLayout {
		t.Fatalf("claude plan did not record its own layout: %q", p.NativeLayout)
	}
	if len(p.Changes.Added) == 0 || len(p.Changes.Changed) != 0 {
		t.Fatalf("review diff omitted the published paths: %+v", p.Changes)
	}
	for _, name := range p.Changes.Added {
		if strings.HasPrefix(name, "skills/") {
			t.Fatalf("a grouped subtree is not discoverable and must not be published: %q", name)
		}
	}

	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(p.TargetPath, "SKILL.md")); err != nil {
		t.Fatal("claude entrypoint is not at the discovery root:", err)
	}
	if _, err := os.Stat(filepath.Join(p.TargetPath, "skills")); !os.IsNotExist(err) {
		t.Fatal("grouped subtree was published alongside the direct layout")
	}

	v, err := s.VerifyPlacement(ctx)
	if err != nil || v.Present.Value == nil || !*v.Present.Value {
		t.Fatalf("fresh verification does not see the published placement: %+v %v", v, err)
	}
	if len(v.DiscoveryNames) != 1 || v.DiscoveryNames[0] != "sjl-"+s.binding.Profile {
		t.Fatalf("discovery names do not describe what a session would advertise: %+v", v.DiscoveryNames)
	}
	if strings.Contains(v.Present.Reason, "legacy") {
		t.Fatalf("claude has no legacy generation to migrate: %q", v.Present.Reason)
	}
}

// A layout belongs to the harness that requires it. A head or plan carrying
// another harness's layout describes a placement this node cannot verify.
func TestClaudePlacementRefusesAnotherHarnessLayout(t *testing.T) {
	s := placementFixtureStore(t)
	s.binding.Harness = "claude-code"
	if s.isDirectLayout(codexDirectLayout) {
		t.Fatal("claude accepted the Codex layout")
	}
	if !s.isDirectLayout(claudeDirectLayout) {
		t.Fatal("claude rejected its own layout")
	}
	s.binding.Harness = "opencode"
	if s.isDirectLayout(claudeDirectLayout) || s.isDirectLayout(codexDirectLayout) {
		t.Fatal("a grouped harness accepted a direct layout")
	}
}

// The scan already covers .claude/skills, so a user's own project skill of the
// same name must stop the operation rather than be overwritten.
func TestClaudePlacementRefusesAUserSkillOfTheSameName(t *testing.T) {
	s := claudePlacementStore(t)
	ctx := context.Background()
	own := filepath.Join(s.binding.WorkspacePath, ".claude/skills/sjl-"+s.binding.Profile)
	if err := os.MkdirAll(own, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(own, "SKILL.md"), []byte("---\nname: mine\n---\nuser's own\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate"); err == nil {
		t.Fatal("planned over a skill this node does not own")
	}
}

// The Claude manifest is allowed into the bundle so the export stays buildable,
// on the condition that it declares nothing executable. A manifest carrying
// hooks, MCP servers, commands or agents must stop publication rather than be
// placed, because this adapter covers plain skills only.
func TestClaudePlacementRefusesAnExecutableManifestComponent(t *testing.T) {
	for _, key := range []string{"hooks", "mcpServers", "commands", "agents"} {
		t.Run(key, func(t *testing.T) {
			s := claudePlacementStore(t)
			ctx := context.Background()
			head, err := s.head()
			if err != nil {
				t.Fatal(err)
			}
			manifest, err := s.verifyGeneration(ctx, head.Current)
			if err != nil {
				t.Fatal(err)
			}
			doctored := map[string]any{
				"name": manifest.Name, "version": manifest.Version,
				"description": "Synthetic fixture.", key: "./whatever",
			}
			body, err := json.Marshal(doctored)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(s.directory, "generations", head.Current.Generation, ".claude-plugin", "plugin.json")
			if err := os.Chmod(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, body, 0600); err != nil {
				t.Fatal(err)
			}
			err = s.placementContent(ctx, head.Current, manifest)
			if err == nil {
				t.Fatalf("%s was accepted into a native publication", key)
			}
			if !strings.Contains(err.Error(), key) {
				t.Fatalf("refusal does not name the component: %v", err)
			}
		})
	}
}
