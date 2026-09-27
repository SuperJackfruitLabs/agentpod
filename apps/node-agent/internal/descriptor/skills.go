package descriptor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// SkillInventoryProvider is optional. Inventory grants no installation, refresh,
// lifecycle or product-operation authority.
type SkillInventoryProvider interface {
	SkillInventory(context.Context, string) (skills.Inventory, error)
}

func localSkillInventory(ctx context.Context, d Descriptor, key string, roots []skills.RootSpec) (skills.Inventory, error) {
	if err := ctx.Err(); err != nil {
		return skills.Inventory{}, err
	}
	stations, err := d.Detect()
	if err != nil {
		return skills.Inventory{}, err
	}
	// Match the complete detected key. Never join a caller's profile suffix to a
	// filesystem path; doing so would allow traversal and undiscovered profiles.
	for _, station := range stations {
		if station.Key == key && station.WorkspacePath != nil {
			return skills.Scan(ctx, key, d.Harness(), *station.WorkspacePath, roots)
		}
	}
	return skills.Inventory{}, fmt.Errorf("skills.inventory: station is not currently detected")
}
func (d *codexDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	inventory, err := localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: ".agents/skills", Scope: "workspace"}})
	if err != nil || len(inventory.Skills) == 0 {
		return inventory, err
	}
	readiness, err := d.NativeSkillReadiness(ctx, key)
	if err != nil {
		return skills.Inventory{}, err
	}
	if !readiness.Ready {
		setCodexLoadingUnknown(&inventory, readiness.Reason)
		return inventory, nil
	}
	workspace, err := d.projectPathForKey(key)
	if err != nil {
		return skills.Inventory{}, err
	}
	nodePath, err := d.nativeSkillDiscoveryNode()
	if err != nil {
		setCodexLoadingUnknown(&inventory, err.Error())
		return inventory, nil
	}
	// Inventory is an operator-facing read that the hub bounds at its own
	// default request deadline (15s). The probe's own bound inside
	// discoverACPSkillCommands is 45s, sized for the verify path, so a cold
	// adapter start could keep the node working past the point where the hub
	// has already answered `timeout` — the operator sees a failure while the
	// node finishes fine. Bound the probe below the hub's deadline here, at
	// the inventory call site only: a shorter parent deadline dominates the
	// inner one, so the verify path in NativeSkillLoading keeps its full 45s.
	probeCtx, cancelProbe := context.WithTimeout(ctx, codexInventoryDiscoveryBound)
	defer cancelProbe()
	advertised, err := d.nativeSkillDiscovery(probeCtx, readiness.AdapterPath, workspace, nodePath)
	if err != nil {
		// Only this bound's expiry gets the named condition. A caller that went
		// away (ctx already done) is a different condition and keeps the
		// generic reason rather than being described as a slow adapter.
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			setCodexLoadingUnknown(&inventory, boundedSkillReason(fmt.Sprintf("Fresh isolated Codex discovery exceeded the %s skills.inventory probe bound, which a cold codex-acp adapter start can do; the bound stays below the hub request deadline so inventory still answers", codexInventoryDiscoveryBound)))
			return inventory, nil
		}
		setCodexLoadingUnknown(&inventory, "Fresh isolated Codex session could not establish discovery: "+boundedSkillReason(err.Error()))
		return inventory, nil
	}
	setCodexLoadingEvidence(&inventory, advertised)
	return inventory, nil
}

// codexInventoryDiscoveryBound caps the fresh-session ACP probe on the
// inventory path. It sits below the hub's 15s default broker deadline
// (apps/hub/src/services/broker.ts) with room to spare for WebSocket
// transport, broker queueing, the filesystem scan and the readiness checks
// that run before the probe, while still leaving more than an order of
// magnitude over the measured 0.42-0.77s steady-state probe. The verify path
// (NativeSkillLoading) is not bounded here: the hub gives it 70s.
const codexInventoryDiscoveryBound = 8 * time.Second

func boundedSkillReason(reason string) string {
	if len(reason) > 512 {
		return reason[:512]
	}
	return reason
}

func setCodexLoadingUnknown(inventory *skills.Inventory, reason string) {
	for i := range inventory.Skills {
		inventory.Skills[i].Evidence.Loaded = skills.Observation{Reason: reason}
	}
	inventory.Coverage.Limitations = append(inventory.Coverage.Limitations, "Codex loading evidence was not collected: "+reason)
}

func setCodexLoadingEvidence(inventory *skills.Inventory, advertised []string) {
	seen := make(map[string]bool, len(advertised))
	for _, name := range advertised {
		seen[name] = true
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for i := range inventory.Skills {
		expected := codexAdvertisedSkillName(inventory.Skills[i])
		if expected == "" {
			inventory.Skills[i].Evidence.Loaded = skills.Observation{Reason: "Fresh isolated Codex discovery ran, but this non-managed layout has no established command-name mapping"}
			continue
		}
		loaded := expected != "" && seen[expected]
		reason := "A fresh isolated ACP session did not advertise this skill"
		if loaded {
			reason = "A fresh isolated ACP session advertised this skill"
		}
		inventory.Skills[i].Evidence.Loaded = skills.Observation{Value: &loaded, ObservedAt: &now, Reason: reason}
	}
}

// codexAdvertisedSkillName recognizes AgentPod's direct native layout. Other
// files retain unknown loading evidence rather than being guessed as an
// AgentPod-managed command.
func codexAdvertisedSkillName(entry skills.Entry) string {
	parts := strings.Split(filepath.ToSlash(entry.ID), "/")
	if len(parts) != 4 || parts[0] != ".agents" || parts[1] != "skills" || !strings.HasPrefix(parts[2], "sjl-") || parts[3] != "SKILL.md" {
		return ""
	}
	name := entry.Name
	if name == "" || strings.Contains(name, ":") {
		return ""
	}
	return name
}
func (d *claudeCodeDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: ".claude/skills", Scope: "workspace"}})
}
func (d *openCodeDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: ".opencode/skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}, {RelativePath: ".claude/skills", Scope: "workspace"}})
}
func (d *piDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: ".pi/skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}})
}
func (d *hermesDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	inventory, err := localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: "skills", Scope: "profile"}, {RelativePath: ".hermes/skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}})
	if err != nil {
		return inventory, err
	}
	// The agentpod-live plugin is reported beside the skills (#553) whenever it
	// is in the profile or apn has a record of installing it: its files, whether
	// the configuration enables it, and what the gateway's log says of its load
	// and last turn. The key was matched against a detected station above.
	if dir, err := d.workspaceFor(key); err == nil {
		if plugin, st := hermeslive.Observe(dir, time.Now()); st.Present || st.Managed {
			inventory.Plugins = append(inventory.Plugins, plugin)
		}
	}
	return inventory, nil
}
func (d *openclawDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: "skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}})
}
func handleSkillInventory(ctx context.Context, reg *Registry, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key string `json:"key"`
	}
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return nil, false, fmt.Errorf("skills.inventory: invalid params")
	}
	if p.Key == "" || len(p.Key) > 512 || decoder.Decode(new(any)) != io.EOF {
		return nil, false, fmt.Errorf("skills.inventory: invalid params")
	}
	d, err := reg.For(p.Key)
	if err != nil {
		return nil, false, err
	}
	provider, ok := d.(SkillInventoryProvider)
	if !ok {
		return nil, false, fmt.Errorf("skills.inventory: capability unavailable")
	}
	result, err := provider.SkillInventory(ctx, p.Key)
	return result, false, err
}
