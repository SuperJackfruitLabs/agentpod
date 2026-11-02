package descriptor

// Characterization of what the hub sees from a registry holding every harness, pinned before the
// package split of the modularity work (docs/contributor/modularity-plan.md, Phase 5). It uses
// only the exported constructors and the verb handler, so it reads the same wherever the
// harnesses live: detect, and per station the ACP spawn command, config.settings, fs.list of the
// workspace root, cleanup.plan and a non-following logs.tail.
//
// Regenerate the golden file with:
//
//	go test ./internal/descriptor -run TestRegistryCharacterization -update-registry-golden

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

var updateRegistryGolden = flag.Bool("update-registry-golden", false, "rewrite testdata/characterization/registry.golden.json")

// characterizationCopyTree copies the fixture tree at src to dst.
func characterizationCopyTree(t *testing.T, src, dst string) {
	t.Helper()
	if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
		t.Fatal(err)
	}
}

func characterizationWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRegistryCharacterization(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fixtures, err := filepath.Abs("testdata")
	if err != nil {
		t.Fatal(err)
	}
	// No harness binary is reachable and nothing is read from the real home.
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	// Every harness binary is a stub on PATH, so the spawn commands do not depend on what the
	// host has installed.
	for _, name := range []string{"node", "npx", "claude", "claude-agent-acp", "codex", "codex-acp", "pi", "pi-acp", "openclaw", "opencode", "hermes", "muse", "kilo"} {
		stub := filepath.Join(bin, name)
		if err := os.WriteFile(stub, []byte("#!/bin/sh\nif [ \"$1\" = --version ]; then echo v22.11.0; fi\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	t.Setenv("HOME", filepath.Join(root, "home"))
	for _, k := range []string{"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "PI_PATH", "PI_ACP_PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"} {
		t.Setenv(k, "")
	}
	t.Setenv("AGENTPOD_WORKSPACE_PATH", filepath.Join(root, "no-workspace"))

	// Hermes and OpenClaw: the committed fixture homes.
	hermesHome := filepath.Join(root, "hermes", ".hermes")
	characterizationCopyTree(t, filepath.Join(fixtures, "hermes", ".hermes"), hermesHome)
	characterizationWrite(t, filepath.Join(hermesHome, "profiles", "coder-kai", "config.yaml"), "model:\n  default: gpt-5\napprovals:\n  mode: manual\n")
	characterizationWrite(t, filepath.Join(hermesHome, "profiles", "coder-kai", ".env"), "MATRIX_USER_ID=@coder-kai:id.example.dev\n")
	openclawHome := filepath.Join(root, "openclaw", ".openclaw")
	characterizationCopyTree(t, filepath.Join(fixtures, "openclaw", ".openclaw"), openclawHome)

	// Claude Code: one project with a session directory named after its path.
	claudeProj := filepath.Join(root, "work", "claude-proj")
	characterizationWrite(t, filepath.Join(claudeProj, "README.md"), "claude project\n")
	characterizationWrite(t, filepath.Join(claudeProj, "node_modules", "x.js"), "x\n")
	claudeHome := filepath.Join(root, "claude", ".claude")
	claudeSess := filepath.Join(claudeHome, "projects", strings.ReplaceAll(claudeProj, "/", "-"))
	characterizationWrite(t, filepath.Join(claudeSess, "s1.jsonl"), fmt.Sprintf("{\"cwd\":%q,\"type\":\"user\"}\n", claudeProj))
	characterizationWrite(t, filepath.Join(root, "claude", ".claude.json"), fmt.Sprintf("{\"projects\":{%q:{}}}", claudeProj))

	// Codex: config.toml trusts one live project and one that is gone.
	codexProj := filepath.Join(root, "work", "codex proj")
	characterizationWrite(t, filepath.Join(codexProj, "main.go"), "package main\n")
	codexHome := filepath.Join(root, "codex", ".codex")
	characterizationWrite(t, filepath.Join(codexHome, "config.toml"), fmt.Sprintf("model = \"gpt-5-codex\"\n\n[projects.%q]\ntrust_level = \"trusted\"\n\n[projects.%q]\ntrust_level = \"trusted\"\n", codexProj, filepath.Join(root, "work", "gone")))
	characterizationWrite(t, filepath.Join(codexHome, "log", "codex-tui.log"), "codex line 1\ncodex line 2\n")

	// OpenCode: one project directory entry, a ghost one, and a log.
	opencodeData := filepath.Join(root, "opencode")
	opencodeProj := filepath.Join(root, "work", "ocproj")
	characterizationWrite(t, filepath.Join(opencodeProj, "app.ts"), "export {}\n")
	characterizationWrite(t, filepath.Join(opencodeData, "project", strings.ReplaceAll(strings.TrimPrefix(opencodeProj, "/"), "/", "-"), "app.json"), "{}")
	if err := os.MkdirAll(filepath.Join(opencodeData, "project", "global"), 0o755); err != nil {
		t.Fatal(err)
	}
	characterizationWrite(t, filepath.Join(opencodeData, "log", "a.log"), "oc 1\noc 2\n")

	// Pi: a session whose header names a hyphenated workspace.
	piData := filepath.Join(root, "pi", "agent")
	piProj := filepath.Join(root, "work", "idea-bank")
	characterizationWrite(t, filepath.Join(piProj, "notes.md"), "pi\n")
	characterizationWrite(t, filepath.Join(piData, "sessions", "--"+strings.ReplaceAll(strings.TrimPrefix(piProj, "/"), "/", "-")+"--", "2026-08-12T08-10-23-796Z_uuid.jsonl"),
		fmt.Sprintf("{\"type\":\"session\",\"version\":3,\"id\":\"x\",\"timestamp\":\"2026-08-12T08:10:23.796Z\",\"cwd\":%q}\n", piProj))

	reg := NewRegistry()
	reg.Register(NewHermes(hermesHome))
	reg.Register(NewOpenClawFrom(OpenClawConfig{Home: openclawHome, SessionLabel: "main", Binary: filepath.Join(bin, "openclaw")}))
	reg.Register(NewClaudeCodeFrom(ClaudeCodeConfig{Home: claudeHome, AcpBinary: filepath.Join(bin, "claude-agent-acp"), ClaudeBinary: filepath.Join(bin, "claude"), NodeBinary: filepath.Join(bin, "node")}))
	reg.Register(NewCodexFrom(CodexConfig{Home: codexHome, AcpBinary: filepath.Join(bin, "codex-acp"), CodexBinary: filepath.Join(bin, "codex"), NodeBinary: filepath.Join(bin, "node")}))
	reg.Register(NewOpenCode(opencodeData))
	reg.Register(NewPi(piData))
	reg.Register(NewMuseFrom(MuseConfig{Home: filepath.Join(root, "muse-absent")}))
	reg.Register(NewKiloFrom(KiloConfig{DataDir: filepath.Join(root, "kilo-absent")}))
	reg.Register(NewSalaamFrom(SalaamConfig{}))
	reg.EnableSkillManagement()
	reg.EnableNativeSkillManagement()
	reg.EnablePluginManagement()
	reg.EnableConfigManagement()
	reg.SetForgeAPIProbe(func() bool { return true })

	h := NewHandler(reg)
	caps := NewCapabilityHandler(reg)
	ctx := context.Background()
	call := func(verb string, params any) any {
		raw, _ := json.Marshal(params)
		var chunks []string
		res, streamed, err := h.Handle(ctx, verb, raw, func(seq int, chunk string, eof bool, enc string) error {
			chunks = append(chunks, fmt.Sprintf("%d|%s|%v|%s", seq, chunk, eof, enc))
			return nil
		})
		out := map[string]any{"streamed": streamed}
		if err != nil {
			out["error"] = err.Error()
		} else {
			out["result"] = res
		}
		if len(chunks) > 0 {
			out["chunks"] = chunks
		}
		return out
	}

	report := map[string]any{"harnesses": reg.Harnesses()}
	// Detect's order follows map iteration, so it is pinned sorted.
	stations := reg.DetectAll()
	sort.Slice(stations, func(i, j int) bool { return stations[i].Key < stations[j].Key })
	report["detect"] = stations
	per := map[string]any{}
	for _, s := range stations {
		argv, dir, env, err := caps.ACPCommand(s.Key)
		acp := map[string]any{"argv": argv, "dir": dir, "env": env}
		if err != nil {
			acp = map[string]any{"error": err.Error()}
		}
		per[s.Key] = map[string]any{
			"acp":             acp,
			"config.settings": call("config.settings", map[string]any{"stationKey": s.Key}),
			"config.observe":  call("config.observe", map[string]any{"stationKey": s.Key}),
			"fs.list":         call("fs.list", map[string]any{"key": s.Key, "path": ""}),
			"cleanup.plan":    call("cleanup.plan", map[string]any{"key": s.Key}),
			"logs.tail":       call("logs.tail", map[string]any{"key": s.Key, "follow": false}),
		}
	}
	report["stations"] = per
	report["unknownVerb"] = call("no.such.verb", map[string]any{})
	report["unknownHarness"] = call("health", map[string]any{"key": "nope:x"})

	got, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	// Temp paths and mtimes differ per run; the shape and every value besides them may not.
	normalized := strings.ReplaceAll(string(got), root, "$ROOT")
	normalized = mtimeRe(normalized)
	// Workspace stations are keyed by a hash of their path, which holds the temp root.
	for _, s := range stations {
		if s.WorkspacePath != nil && !strings.Contains(s.Key, filepath.Base(*s.WorkspacePath)) && s.ParentKey == nil && strings.Contains(s.Key, ":") {
			normalized = strings.ReplaceAll(normalized, s.Key, s.Harness+":<hash of "+strings.ReplaceAll(*s.WorkspacePath, root, "$ROOT")+">")
		}
	}
	golden := filepath.Join("testdata", "characterization", "registry.golden.json")
	if *updateRegistryGolden {
		characterizationWrite(t, golden, normalized+"\n")
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("%v (run with -update-registry-golden to create it)", err)
	}
	if strings.TrimSpace(string(want)) != strings.TrimSpace(normalized) {
		t.Errorf("registry output changed.\n--- got ---\n%s", normalized)
	}
}

// mtimeRe blanks the RFC 3339 timestamps fs.list reports as each entry's modification time.
func mtimeRe(s string) string {
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if i := strings.Index(line, `"modified": "`); i >= 0 {
			j := strings.Index(line[i+len(`"modified": "`):], `"`)
			if j >= 0 {
				line = line[:i] + `"modified": "<mtime>"` + line[i+len(`"modified": "`)+j+1:]
			}
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}
