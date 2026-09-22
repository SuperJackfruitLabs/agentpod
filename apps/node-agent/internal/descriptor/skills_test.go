package descriptor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

func TestSkillInventoryIsOptionalAndScopedToDetectedStation(t *testing.T) {
	home := t.TempDir()
	skill := filepath.Join(home, "profiles", "writer", "skills", "example")
	if err := os.MkdirAll(skill, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: example\ndescription: A fixture\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	d := NewHermes(home)
	provider, ok := d.(SkillInventoryProvider)
	if !ok {
		t.Fatal("optional provider missing")
	}
	result, err := provider.SkillInventory(context.Background(), "hermes:writer")
	if err != nil || len(result.Skills) != 1 {
		t.Fatalf("%+v %v", result, err)
	}
	if result.Skills[0].Scope != "profile" {
		t.Fatal("profile scope lost")
	}
	for _, key := range []string{"hermes:absent", "hermes:../writer", "hermes:../../other", "openclaw:writer"} {
		if _, err := provider.SkillInventory(context.Background(), key); err == nil {
			t.Fatalf("accepted %q", key)
		}
	}
	reg := NewRegistry()
	reg.Register(d)
	h := NewHandler(reg)
	for _, params := range []string{`{}`, `{"key":""}`, `{"key":"hermes:writer","path":"/other"}`, `{"key":"hermes:writer"} {}`} {
		if _, _, err := h.Handle(context.Background(), "skills.inventory", json.RawMessage(params), nil); err == nil {
			t.Fatalf("accepted %s", params)
		}
	}
	value, stream, err := h.Handle(context.Background(), "skills.inventory", json.RawMessage(`{"key":"hermes:writer"}`), nil)
	if err != nil || stream || value == nil {
		t.Fatalf("dispatch: %v", err)
	}
}

func TestAllSkillInventoryDescriptorsImplementOptionalInterface(t *testing.T) {
	home := t.TempDir()
	for _, d := range []Descriptor{NewHermes(home), NewOpenClaw(home), NewCodex(home), NewClaudeCode(home), NewOpenCode(home), NewPi(home)} {
		if _, ok := d.(SkillInventoryProvider); !ok {
			t.Fatalf("%s lacks its advertised provider", d.Harness())
		}
	}
}

// newReadyCodexDiscoveryFixture builds a codex station whose native-skill
// readiness gate passes, so a caller can drive the discovery probe itself. It
// returns the descriptor, the workspace and the resolved adapter shim.
func newReadyCodexDiscoveryFixture(t *testing.T) (*codexDescriptor, string, string) {
	t.Helper()
	home, project, _ := buildCodexFixture(t)
	skill := filepath.Join(project, ".agents", "skills", "sjl-fixture")
	if err := os.MkdirAll(skill, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: sjl-fixture\ndescription: Fixture\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	unmanaged := filepath.Join(project, ".agents", "skills", "local")
	if err := os.MkdirAll(unmanaged, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unmanaged, "SKILL.md"), []byte("---\nname: local\ndescription: Local fixture\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	d := newTestCodex(t, home, false)
	root := t.TempDir()
	pkg := filepath.Join(root, "node_modules", "@agentclientprotocol", "codex-acp")
	entry := filepath.Join(pkg, "dist", "index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkg, "package.json"), []byte(`{"name":"@agentclientprotocol/codex-acp","version":"1.12.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	engine := filepath.Join(pkg, "node_modules", "@openai", "codex", "package.json")
	if err := os.MkdirAll(filepath.Dir(engine), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine, []byte(`{"name":"@openai/codex","version":"0.154.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(root, "codex-acp")
	if err := os.Symlink(entry, shim); err != nil {
		t.Fatal(err)
	}
	d.acpBinary = shim
	d.adapterRunning = func(string, string) (bool, string) { return false, "" }
	d.nodeBinary = "/opt/agentpod/node/bin/node"
	d.nodeVersion = func(path string) (string, error) {
		if path != d.nodeBinary {
			t.Fatalf("resolved unexpected Node runtime %q", path)
		}
		return "v22.14.0", nil
	}
	return d, project, shim
}

func TestCodexSkillInventoryUsesFreshIsolatedDiscoveryEvidence(t *testing.T) {
	d, project, shim := newReadyCodexDiscoveryFixture(t)
	called := false
	d.nativeSkillDiscovery = func(ctx context.Context, adapter, workspace, node string) ([]string, error) {
		called = true
		if adapter != shim || workspace != project || node != d.nodeBinary {
			t.Fatalf("unexpected discovery scope %q %q node=%q", adapter, workspace, node)
		}
		return []string{"sjl-fixture"}, nil
	}
	result, err := d.SkillInventory(context.Background(), codexKeyFor(project))
	if err != nil || !called || len(result.Skills) != 2 {
		t.Fatalf("result=%+v called=%v err=%v", result, called, err)
	}
	byName := map[string]skills.Entry{}
	for _, entry := range result.Skills {
		byName[entry.Name] = entry
	}
	loaded := byName["sjl-fixture"].Evidence.Loaded
	if loaded.Value == nil || !*loaded.Value || loaded.ObservedAt == nil || !strings.Contains(loaded.Reason, "fresh isolated ACP") {
		t.Fatalf("unexpected loading evidence: %+v", loaded)
	}
	if loaded = byName["local"].Evidence.Loaded; loaded.Value != nil || !strings.Contains(loaded.Reason, "no established command-name mapping") {
		t.Fatalf("unmanaged skill loading evidence: %+v", loaded)
	}
	loading, err := d.NativeSkillLoading(context.Background(), codexKeyFor(project), []string{"sjl-fixture"})
	if err != nil || loading.Value == nil || !*loading.Value || loading.ObservedAt == nil {
		t.Fatalf("native loading: %+v %v", loading, err)
	}
	loading, err = d.NativeSkillLoading(context.Background(), codexKeyFor(project), []string{"missing"})
	if err != nil || loading.Value == nil || *loading.Value {
		t.Fatalf("missing native name claimed loaded: %+v %v", loading, err)
	}
}

func TestSkillInventoryUnsupportedDescriptorDoesNotFallbackToFiles(t *testing.T) {
	reg := NewRegistry()
	reg.Register(&fakeDescriptor{harness: "fake"})
	_, _, err := NewHandler(reg).Handle(context.Background(), "skills.inventory", json.RawMessage(`{"key":"fake:station"}`), nil)
	if err == nil {
		t.Fatal("unsupported descriptor accepted inventory")
	}
}

// The hub bounds skills.inventory at its 15s broker default, so the node's
// probe must answer inside that window. A probe that exceeds the inventory
// bound has to degrade to unknown loading evidence naming the condition —
// never a "not loaded" claim, and never a failed inventory.
func TestCodexSkillInventoryBoundsDiscoveryBelowHubRequestDeadline(t *testing.T) {
	d, project, _ := newReadyCodexDiscoveryFixture(t)
	var remaining time.Duration
	var hadDeadline bool
	d.nativeSkillDiscovery = func(ctx context.Context, adapter, workspace, node string) ([]string, error) {
		deadline, ok := ctx.Deadline()
		hadDeadline = ok
		if ok {
			remaining = time.Until(deadline)
		}
		// What discoverACPSkillCommands reports when its context expires.
		return nil, fmt.Errorf("ACP discovery deadline exceeded: %w", context.DeadlineExceeded)
	}
	result, err := d.SkillInventory(context.Background(), codexKeyFor(project))
	if err != nil {
		t.Fatalf("a probe timeout must not fail the whole inventory: %v", err)
	}
	if !hadDeadline {
		t.Fatal("inventory probe ran with no deadline of its own")
	}
	if remaining > codexInventoryDiscoveryBound || remaining < codexInventoryDiscoveryBound-time.Second {
		t.Fatalf("probe deadline %s is not the inventory bound %s", remaining, codexInventoryDiscoveryBound)
	}
	if codexInventoryDiscoveryBound >= 15*time.Second {
		t.Fatalf("inventory bound %s does not sit below the hub's 15s broker default", codexInventoryDiscoveryBound)
	}
	if len(result.Skills) != 2 {
		t.Fatalf("filesystem inventory lost on probe timeout: %+v", result.Skills)
	}
	for _, entry := range result.Skills {
		loaded := entry.Evidence.Loaded
		if loaded.Value != nil {
			t.Fatalf("%s claimed a loading state after a probe timeout: %+v", entry.Name, loaded)
		}
		if loaded.ObservedAt != nil {
			t.Fatalf("%s carries an observation time with no observation: %+v", entry.Name, loaded)
		}
		if !strings.Contains(loaded.Reason, "probe bound") || !strings.Contains(loaded.Reason, "cold codex-acp adapter start") {
			t.Fatalf("%s reason does not name the condition: %q", entry.Name, loaded.Reason)
		}
		if strings.Contains(loaded.Reason, "context deadline exceeded") {
			t.Fatalf("%s surfaced the bare context error: %q", entry.Name, loaded.Reason)
		}
	}
	if len(result.Coverage.Limitations) == 0 {
		t.Fatal("probe timeout was not reported as a coverage limitation")
	}
}

// The inventory bound belongs to the inventory call site only. The verify path
// keeps the longer bound that discoverACPSkillCommands applies internally, so
// NativeSkillLoading must not inherit an 8s deadline from this change.
func TestCodexNativeSkillLoadingKeepsTheLongerProbeBound(t *testing.T) {
	d, project, _ := newReadyCodexDiscoveryFixture(t)
	var deadlines []time.Duration
	var bounded []bool
	d.nativeSkillDiscovery = func(ctx context.Context, adapter, workspace, node string) ([]string, error) {
		deadline, ok := ctx.Deadline()
		bounded = append(bounded, ok)
		if ok {
			deadlines = append(deadlines, time.Until(deadline))
		}
		return []string{"sjl-fixture"}, nil
	}
	if _, err := d.SkillInventory(context.Background(), codexKeyFor(project)); err != nil {
		t.Fatal(err)
	}
	loading, err := d.NativeSkillLoading(context.Background(), codexKeyFor(project), []string{"sjl-fixture"})
	if err != nil || loading.Value == nil || !*loading.Value {
		t.Fatalf("verify path: %+v %v", loading, err)
	}
	if len(bounded) != 2 || !bounded[0] {
		t.Fatalf("inventory probe was not bounded: %v", bounded)
	}
	if bounded[1] {
		t.Fatalf("verify probe inherited a call-site deadline of %s; the 45s inside discoverACPSkillCommands must govern it", deadlines[len(deadlines)-1])
	}
}

// A caller that goes away is a different condition from a slow adapter, and
// must not be described as one.
func TestCodexSkillInventoryDoesNotBlameTheAdapterForACancelledCaller(t *testing.T) {
	d, project, _ := newReadyCodexDiscoveryFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	d.nativeSkillDiscovery = func(context.Context, string, string, string) ([]string, error) {
		cancel()
		return nil, fmt.Errorf("ACP discovery deadline exceeded: %w", context.DeadlineExceeded)
	}
	result, err := d.SkillInventory(ctx, codexKeyFor(project))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range result.Skills {
		loaded := entry.Evidence.Loaded
		if loaded.Value != nil {
			t.Fatalf("%s claimed a loading state: %+v", entry.Name, loaded)
		}
		if strings.Contains(loaded.Reason, "cold codex-acp adapter start") {
			t.Fatalf("%s blamed a cold adapter start for a cancelled caller: %q", entry.Name, loaded.Reason)
		}
	}
}
