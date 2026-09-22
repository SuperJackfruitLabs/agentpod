package descriptor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// openclawSkillListTimeout bounds the harness report. It runs a CLI that scans
// the skills directory and prints an inventory; it starts no session, opens no
// gateway and sends no prompt.
const openclawSkillListTimeout = 20 * time.Second

// The states a placement must keep apart. A skill that is present but will not
// load is not the same claim as a skill that was never placed, and reporting
// either as the other would make a broken placement look like a clean removal.
const (
	openclawSkillReady      = "ready"
	openclawSkillIneligible = "ineligible"
	openclawSkillDisabled   = "disabled"
	openclawSkillBlocked    = "blocked"
)

// NativeSkillLoading answers whether OpenClaw would load the names a verified
// generation published, by asking OpenClaw rather than by opening a session.
//
// Like Hermes, and unlike Codex, Claude, OpenCode and Pi, OpenClaw does not
// advertise a placed skill as a session command, so the ACP probe that closes
// those gates cannot close this one. `openclaw skills list --json` reports each
// skill with whether it is eligible, disabled or blocked by the allowlist,
// which is what a placement needs to claim. It is the harness's own account of
// what it would load rather than a running session's account of itself, and
// the observation says so.
func (o *openclawDescriptor) NativeSkillLoading(ctx context.Context, key string, expected []string) (skills.Observation, error) {
	if len(expected) == 0 {
		return skills.Observation{Reason: "No native skill names were supplied to verify"}, nil
	}
	readiness, err := o.NativeSkillReadiness(ctx, key)
	if err != nil {
		return skills.Observation{}, err
	}
	if !readiness.Ready {
		return skills.Observation{Reason: readiness.Reason}, nil
	}
	listed, err := openclawListedSkills(ctx, readiness.AdapterPath)
	if err != nil {
		return skills.Observation{}, fmt.Errorf("openclaw could not report its skills: %w", err)
	}
	for _, name := range expected {
		state, present := listed[name]
		if !present {
			return observedNativeSkillLoading(false, "OpenClaw does not list "+name+" among the skills it would load"), nil
		}
		if state != openclawSkillReady {
			// Present but not loadable is neither loaded nor absent, and must
			// not be reported as either.
			return skills.Observation{Reason: "OpenClaw lists " + name + " as " + state + " rather than ready"}, nil
		}
	}
	return observedNativeSkillLoading(true, "OpenClaw lists every expected native skill as ready; this is the harness's own report, not a session's"), nil
}

// openclawListedSkills runs the harness report and returns each skill name with
// the state OpenClaw gives it.
func openclawListedSkills(ctx context.Context, binary string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, openclawSkillListTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "skills", "list", "--json")
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		summary := strings.Join(strings.Fields(errOut.String()), " ")
		if len(summary) > 300 {
			summary = summary[:300]
		}
		if summary != "" {
			return nil, fmt.Errorf("%w: %s", err, summary)
		}
		return nil, err
	}
	return parseOpenClawSkillReport(out.Bytes())
}

// parseOpenClawSkillReport reads the JSON inventory.
//
// A row without a name is dropped rather than guessed at, and output that does
// not decode at all is an error rather than an empty inventory -- an empty
// inventory would read as "the skill is not there", which is the one wrong
// answer a removal check must never be handed.
func parseOpenClawSkillReport(output []byte) (map[string]string, error) {
	var rows []struct {
		Name               string `json:"name"`
		Eligible           bool   `json:"eligible"`
		Disabled           bool   `json:"disabled"`
		BlockedByAllowlist bool   `json:"blockedByAllowlist"`
	}
	if err := json.Unmarshal(output, &rows); err != nil {
		return nil, fmt.Errorf("openclaw: unreadable skill report: %w", err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("openclaw: skill report listed nothing, which is never true of a working install")
	}
	listed := make(map[string]string, len(rows))
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		if name == "" {
			continue
		}
		switch {
		case row.BlockedByAllowlist:
			listed[name] = openclawSkillBlocked
		case row.Disabled:
			listed[name] = openclawSkillDisabled
		case !row.Eligible:
			listed[name] = openclawSkillIneligible
		default:
			listed[name] = openclawSkillReady
		}
	}
	return listed, nil
}
