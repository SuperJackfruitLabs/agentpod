package descriptor

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// hermesSkillListTimeout bounds the harness report. It runs a CLI that reads
// the profile and prints a table; it starts no session and sends no prompt.
const hermesSkillListTimeout = 20 * time.Second

// NativeSkillLoading answers whether Hermes would load the names a verified
// generation published, by asking Hermes rather than by opening a session.
//
// A fresh ACP session was tried first and does not work: Hermes advertises only
// its own built-in commands and never the published skill, so the check that
// closes Codex's and Claude's gates cannot close this one. `hermes skills list`
// reports each skill by name with its source and whether it is enabled, which
// is what a placement needs to claim. It is the harness's own account of what
// it would load, not a running session's account of itself, and the observation
// says so.
func (h *hermesDescriptor) NativeSkillLoading(ctx context.Context, key string, expected []string) (skills.Observation, error) {
	if len(expected) == 0 {
		return skills.Observation{Reason: "No native skill names were supplied to verify"}, nil
	}
	readiness, err := h.NativeSkillReadiness(ctx, key)
	if err != nil {
		return skills.Observation{}, err
	}
	if !readiness.Ready {
		return skills.Observation{Reason: readiness.Reason}, nil
	}
	profile, err := hermesProfileName(key)
	if err != nil {
		return skills.Observation{}, err
	}
	listed, err := hermesListedSkills(ctx, readiness.AdapterPath, profile)
	if err != nil {
		return skills.Observation{}, fmt.Errorf("hermes could not report its skills: %w", err)
	}
	for _, name := range expected {
		state, present := listed[name]
		if !present {
			return observedNativeSkillLoading(false, "Hermes does not list "+name+" among the skills it would load"), nil
		}
		if state != "enabled" {
			// Present but not enabled is neither loaded nor absent, and must
			// not be reported as either.
			return skills.Observation{Reason: "Hermes lists " + name + " as " + state + " rather than enabled"}, nil
		}
	}
	return observedNativeSkillLoading(true, "Hermes lists every expected native skill as enabled; this is the harness's own report, not a session's"), nil
}

// hermesListedSkills runs the harness report and returns each skill name with
// the state Hermes gives it. The output is a table, so parsing is deliberately
// narrow: a row is only read when it names a skill and carries a state, and an
// unreadable table yields no names rather than a guess.
func hermesListedSkills(ctx context.Context, binary, profile string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, hermesSkillListTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-p", profile, "skills", "list")
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
	return parseHermesSkillTable(out.Bytes())
}

// parseHermesSkillTable reads the harness report. Parsing is deliberately
// narrow: a row is read only when it names a skill and carries a state, so an
// unreadable or reformatted table yields no names rather than a guess.
func parseHermesSkillTable(output []byte) (map[string]string, error) {
	listed := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		cells := strings.Split(scanner.Text(), "\u2502")
		if len(cells) < 3 {
			continue
		}
		name := strings.TrimSpace(cells[1])
		if name == "" || strings.EqualFold(name, "name") {
			continue
		}
		state := ""
		for _, cell := range cells[2:] {
			switch strings.TrimSpace(cell) {
			case "enabled", "disabled":
				state = strings.TrimSpace(cell)
			}
		}
		if state != "" {
			listed[name] = state
		}
	}
	return listed, scanner.Err()
}

func hermesProfileName(key string) (string, error) {
	name := strings.TrimPrefix(key, "hermes:")
	if name == "" || name == key || strings.ContainsAny(name, "/\\ ") {
		return "", fmt.Errorf("hermes: unrecognized profile key %q", key)
	}
	return name, nil
}

// NativeSkillInventory reports the skill names this Hermes profile already
// holds, from the same report the loading check reads.
func (h *hermesDescriptor) NativeSkillInventory(ctx context.Context, key string) (map[string]string, error) {
	readiness, err := h.NativeSkillReadiness(ctx, key)
	if err != nil {
		return nil, err
	}
	if !readiness.Ready {
		return nil, nil
	}
	profile, err := hermesProfileName(key)
	if err != nil {
		return nil, err
	}
	return hermesListedSkills(ctx, readiness.AdapterPath, profile)
}
