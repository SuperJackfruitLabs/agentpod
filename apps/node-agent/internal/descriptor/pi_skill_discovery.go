package descriptor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// piACPDiscoverSkills starts the selected adapter with a disposable HOME and a
// synthetic provider, sends only ACP initialize and session/new, and returns
// the skill commands the session advertises.
//
// Pi loads project-local skills only when the run trusts them, and exposes
// each as a slash command named skill:<id>. Its adapter takes the engine as a
// path through PI_ACP_PI_COMMAND and does not split arguments out of it, so
// the trust flag is passed by a wrapper written into the probe's own throwaway
// directory. Nothing is written to the workspace or to the operator's Pi home.
//
// A session opens only with a credential present, so the probe supplies a
// synthetic key against an unreachable local address. No prompt is sent.
func piACPDiscoverSkills(ctx context.Context, adapter, engine, workspace string) ([]string, error) {
	if adapter == "" || engine == "" || !filepath.IsAbs(adapter) || !filepath.IsAbs(engine) || !filepath.IsAbs(workspace) {
		return nil, fmt.Errorf("invalid Pi discovery scope")
	}
	scratch, err := os.MkdirTemp("", "agentpod-pi-skill-discovery-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(scratch)
	home := filepath.Join(scratch, "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		return nil, err
	}
	// The wrapper exists only so the probed run trusts project files. It is
	// this node's file, in this node's temporary directory, and is removed
	// with it.
	wrapper := filepath.Join(scratch, "pi-approve")
	script := "#!/bin/sh\nexec " + shellQuote(engine) + " --approve \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		return nil, err
	}
	return discoverACPSkillCommands(ctx, []string{adapter}, workspace, []string{
		"PATH=" + pathWithDirFirst(filepath.Dir(engine), os.Getenv("PATH")),
		"HOME=" + home,
		"PI_ACP_PI_COMMAND=" + wrapper,
		"OPENAI_API_KEY=agentpod-offline-skill-discovery",
		"ANTHROPIC_API_KEY=agentpod-offline-skill-discovery",
		"GOOGLE_API_KEY=agentpod-offline-skill-discovery",
		"GEMINI_API_KEY=agentpod-offline-skill-discovery",
		"NO_BROWSER=1", "LANG=C",
	}, func(name string) (string, bool) {
		// Pi names a skill command skill:<id>; everything else is a built-in.
		return strings.TrimPrefix(name, "skill:"), strings.HasPrefix(name, "skill:")
	})
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// NativeSkillLoading answers whether a fresh Pi session advertises the names a
// verified generation published.
//
// The observation is qualified and says so: the probed run trusts project
// files, because Pi does not load them otherwise. A positive result means a
// session that trusts this project would offer the skill, not that every
// session will. An operator whose sessions do not trust the project will not
// see it, and that is a decision they own rather than one a placement makes.
func (p *piDescriptor) NativeSkillLoading(ctx context.Context, key string, expected []string) (skills.Observation, error) {
	if len(expected) == 0 {
		return skills.Observation{Reason: "No native skill names were supplied to verify"}, nil
	}
	readiness, err := p.NativeSkillReadiness(ctx, key)
	if err != nil {
		return skills.Observation{}, err
	}
	if !readiness.Ready {
		return skills.Observation{Reason: readiness.Reason}, nil
	}
	workspace, err := p.workspaceForKey(key)
	if err != nil {
		return skills.Observation{}, err
	}
	engine, ok := p.piBinary()
	if !ok {
		return skills.Observation{Reason: "The selected Pi executable is unresolved"}, nil
	}
	engine, err = filepath.Abs(engine)
	if err != nil {
		return skills.Observation{}, err
	}
	advertised, err := p.nativeSkillDiscovery(ctx, readiness.AdapterPath, engine, workspace)
	if err != nil {
		return skills.Observation{}, fmt.Errorf("fresh isolated Pi session could not establish discovery: %w", err)
	}
	seen := make(map[string]bool, len(advertised))
	for _, name := range advertised {
		seen[name] = true
	}
	for _, name := range expected {
		if !seen[name] {
			return observedNativeSkillLoading(false, "A fresh isolated ACP session trusting project files did not advertise "+name), nil
		}
	}
	return observedNativeSkillLoading(true, "A fresh isolated ACP session trusting project files advertised every expected native skill; a session that does not trust this project will not load them"), nil
}
