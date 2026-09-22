package descriptor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// nativeExecutableVersion measures the selected executable without starting a
// session. A bounded, single-line version is diagnostic evidence, not a native
// loading claim.
func nativeExecutableVersion(ctx context.Context, binary string) string {
	if !filepath.IsAbs(binary) || !isExecutableFile(binary) {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "--version")
	// A harness binary is frequently a script whose interpreter lives beside
	// it -- `pi` and `pi-acp` are Node programs installed next to `node`. A
	// node-agent started by launchd or systemd inherits a PATH without that
	// directory, so the exec fails to find the INTERPRETER and the probe
	// reports no version, which readiness then states as a version problem.
	// The discovery probe already prepends this directory; doing the same here
	// keeps the two from disagreeing about whether a harness can run at all.
	cmd.Env = append(os.Environ(), "PATH="+pathWithDirFirst(filepath.Dir(binary), os.Getenv("PATH")))
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	version := strings.TrimSpace(string(out))
	if len(version) == 0 || len(version) > 128 || strings.ContainsAny(version, "\r\n\x00") {
		return ""
	}
	return version
}

// Versions whose fresh isolated ACP session was observed advertising a skill
// published at .opencode/skills/<name>/SKILL.md. Each entry is one probe that
// was actually run; a version absent here is refused rather than assumed to
// behave like a neighbour.
var openCodeDiscoveryEvidence = map[string]bool{"1.18.15": true, "1.18.30": true}

// resolveNativeHarnessBinary resolves a harness executable for a native
// readiness check.
//
// PATH alone is not enough. A node started by launchd or systemd inherits a
// PATH that usually excludes the directories harnesses install into --
// /opt/homebrew/bin above all -- and `binaryLocator` already carries that
// knowledge for every other resolution in this package. These readiness paths
// called exec.LookPath directly, so OpenCode was refused as "unresolved" on a
// machine where it was installed and on PATH for the operator, while Hermes
// resolved only because /usr/local/bin happens to sit on the default PATH.
func resolveNativeHarnessBinary(name string) (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return binaryLocator{
		userHome:     home,
		lookPath:     exec.LookPath,
		isExecutable: isExecutableFile,
	}.locate(name, "")
}

func openCodeSupportedVersions() string {
	versions := make([]string, 0, len(openCodeDiscoveryEvidence))
	for version := range openCodeDiscoveryEvidence {
		versions = append(versions, version)
	}
	sort.Strings(versions)
	return strings.Join(versions, ", ")
}

// Native placement fixture probes establish on-disk discovery for particular
// CLI versions. OpenCode also has a fresh ACP comparison and a process gate;
// Pi and OpenClaw remain closed until their ACP and quiescence evidence exists.
func (o *openCodeDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	if _, err := o.projectPathForKey(key); err != nil {
		return NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	result := NativeSkillReadiness{Harness: "opencode", Reason: "Selected OpenCode executable is unresolved"}
	binary, ok := resolveNativeHarnessBinary("opencode")
	if !ok {
		return result, nil
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		return result, nil
	}
	result.AdapterPath = binary
	result.EngineVersion = nativeExecutableVersion(ctx, binary)
	if result.EngineVersion == "" {
		result.Reason = "Selected OpenCode version is unavailable"
	} else if !openCodeDiscoveryEvidence[result.EngineVersion] {
		result.Reason = fmt.Sprintf("OpenCode %s has no recorded native ACP discovery evidence; supported versions are %s", result.EngineVersion, openCodeSupportedVersions())
	} else if running, note := o.nativeProcessRunning(); note != "" {
		result.Reason = "OpenCode process inspection failed: " + note
	} else if running {
		result.Reason = "An OpenCode process is active; native publication requires a quiescent runtime"
	} else {
		result.Ready = true
		result.Reason = "OpenCode " + result.EngineVersion + " matches isolated ACP skill discovery evidence and no OpenCode process is active"
	}
	return result, nil
}

// NativeSkillLoading compares the exact names in the verified native receipt
// with a fresh, isolated ACP session. It does not refresh a user's active chat.
func (o *openCodeDescriptor) NativeSkillLoading(ctx context.Context, key string, expected []string) (skills.Observation, error) {
	if len(expected) == 0 {
		return skills.Observation{Reason: "No native skill names are selected for this placement"}, nil
	}
	readiness, err := o.NativeSkillReadiness(ctx, key)
	if err != nil {
		return skills.Observation{}, err
	}
	if !readiness.Ready {
		return skills.Observation{Reason: readiness.Reason}, nil
	}
	workspace, err := o.projectPathForKey(key)
	if err != nil {
		return skills.Observation{}, err
	}
	advertised, err := o.nativeSkillDiscovery(ctx, readiness.AdapterPath, workspace)
	if err != nil {
		return skills.Observation{}, fmt.Errorf("fresh isolated OpenCode session could not establish discovery: %w", err)
	}
	seen := make(map[string]bool, len(advertised))
	for _, name := range advertised {
		seen[name] = true
	}
	for _, name := range expected {
		if !seen[name] {
			return observedNativeSkillLoading(false, "A fresh isolated OpenCode ACP session did not advertise "+name), nil
		}
	}
	return observedNativeSkillLoading(true, "A fresh isolated OpenCode ACP session advertised every expected native skill name"), nil
}

func openCodeACPDiscoverSkills(ctx context.Context, binary, workspace string) ([]string, error) {
	root, err := os.MkdirTemp("", "agentpod-opencode-discovery-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(root)
	home := filepath.Join(root, "home")
	if err := os.Mkdir(home, 0700); err != nil {
		return nil, err
	}
	env := []string{
		"HOME=" + home,
		"PATH=/usr/bin:/bin",
		"OPENCODE_DISABLE_AUTOUPDATE=1",
		"OPENCODE_DISABLE_MODELS_FETCH=1",
		"OPENCODE_DISABLE_DEFAULT_PLUGINS=1",
		"OPENCODE_DISABLE_SHARE=1",
		"XDG_CONFIG_HOME=" + filepath.Join(root, "config"),
		"XDG_CACHE_HOME=" + filepath.Join(root, "cache"),
		"XDG_DATA_HOME=" + filepath.Join(root, "data"),
		"XDG_STATE_HOME=" + filepath.Join(root, "state"),
		`OPENCODE_CONFIG_CONTENT={"autoupdate":false,"share":"disabled","plugin":[]}`,
	}
	return discoverACPSkillCommands(ctx, []string{binary, "acp"}, workspace, env, func(name string) (string, bool) {
		if name == "" || strings.ContainsAny(name, "/\\\x00\r\n") {
			return "", false
		}
		return name, true
	})
}

func (p *piDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	if _, err := p.workspaceForKey(key); err != nil {
		return NativeSkillReadiness{}, err
	}
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	result := NativeSkillReadiness{Harness: "pi", Reason: "Selected Pi or pi-acp executable is unresolved"}
	engine, engineOK := p.piBinary()
	adapter, adapterOK := p.acpAdapter()
	if !engineOK || !adapterOK {
		return result, nil
	}
	engine, engineErr := filepath.Abs(engine)
	adapter, adapterErr := filepath.Abs(adapter)
	if engineErr != nil || adapterErr != nil {
		return result, nil
	}
	result.AdapterPath = adapter
	result.EngineVersion = nativeExecutableVersion(ctx, engine)
	if resolved, err := filepath.EvalSymlinks(adapter); err == nil {
		result.AdapterVersion = packageVersionInParents(resolved, "pi-acp")
	}
	if result.EngineVersion == "" || result.AdapterVersion == "" {
		result.Reason = "Selected Pi engine or pi-acp package version is unavailable"
		return result, nil
	}
	// This engine is the one whose fresh isolated session was observed
	// advertising skill:<id> for a skill published under .pi/skills, once the
	// run trusted project files. Another engine has no such evidence.
	if !piDiscoveryEvidence[result.EngineVersion] {
		result.Reason = fmt.Sprintf("Pi %s through pi-acp %s has no recorded ACP skill discovery evidence", result.EngineVersion, result.AdapterVersion)
		return result, nil
	}
	if running, note := piProcessRunning(); note != "" {
		result.Reason = "Pi process inspection failed: " + note
		return result, nil
	} else if running {
		result.Reason = "A Pi process is active on this host"
		return result, nil
	}
	result.Ready = true
	result.Reason = fmt.Sprintf("Pi %s through pi-acp %s matches isolated ACP discovery evidence; project trust remains the operator's decision and an untrusting session will not load a placed skill", result.EngineVersion, result.AdapterVersion)
	return result, nil
}

// Engines whose fresh isolated ACP session was observed advertising a skill
// published under .pi/skills. A version absent here is refused rather than
// assumed to behave like a neighbour.
var piDiscoveryEvidence = map[string]bool{"0.84.1": true}

// piProcessRunning reports whether any Pi process is active. Pi has no daemon
// and is invoked per command, so this is a coarse guard against publishing
// underneath a command that is mid-run.
func piProcessRunning() (bool, string) {
	return processRunningInWorkspace("^pi$", "/")
}

// Versions whose skills directory was observed being read. Each entry is one
// probe that was actually run against an installed build: a fixture written to
// <home>/skills/<name>/SKILL.md, then `openclaw skills list --json` and
// `openclaw skills check`, then removal and the same two reports again.
//
// This gate was previously closed for every version with the reason that
// native publication "needs a gateway quiescence and ACP loading gate". That
// was an assumption rather than an observation, and the probe refuted it: the
// inventory is a directory scan performed per invocation, the placed skill was
// reported ready with no gateway running at all, and removing it dropped the
// count back. What remains true, and is kept above, is the REMOTE gateway
// case, which OpenClaw's documentation says never falls back to local skills.
//
// A version absent here is refused rather than assumed to behave like a
// neighbour.
var openClawDiscoveryEvidence = map[string]bool{
	"2026.2.12": true,
}

func openClawSupportedVersions() string {
	versions := make([]string, 0, len(openClawDiscoveryEvidence))
	for version := range openClawDiscoveryEvidence {
		versions = append(versions, version)
	}
	sort.Strings(versions)
	return strings.Join(versions, ", ")
}

func (o *openclawDescriptor) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	if err := ctx.Err(); err != nil {
		return NativeSkillReadiness{}, err
	}
	stations, err := o.Detect()
	if err != nil {
		return NativeSkillReadiness{}, err
	}
	found := false
	for _, station := range stations {
		if station.Key == key {
			found = true
			break
		}
	}
	if !found {
		return NativeSkillReadiness{}, fmt.Errorf("openclaw: station not found: %q", key)
	}
	result := NativeSkillReadiness{Harness: "openclaw", Reason: "Selected OpenClaw executable is unresolved"}
	binary, err := o.resolveBinary()
	if err != nil {
		return result, nil
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		return result, nil
	}
	result.AdapterPath = binary
	if resolved, err := filepath.EvalSymlinks(binary); err == nil {
		result.EngineVersion = packageVersionInParents(resolved, "openclaw")
	}
	if result.EngineVersion == "" {
		result.EngineVersion = nativeExecutableVersion(ctx, binary)
	}
	if result.EngineVersion == "" {
		result.Reason = "Selected OpenClaw version is unavailable"
	} else if o.gatewayURL != "" {
		// A CONFIGURED REMOTE gateway is authoritative for its own inventory
		// and, per OpenClaw's own documentation, "never falls back to
		// client-local skills". Publishing into this node's skills directory
		// would place files nothing reads, so this stays refused. Only the
		// local case below was ever observable.
		result.Reason = "Configured remote OpenClaw gateway is authoritative for its skill inventory and does not read this node's skills directory"
	} else if !openClawDiscoveryEvidence[result.EngineVersion] {
		result.Reason = fmt.Sprintf("OpenClaw %s has no recorded native skill discovery evidence; supported versions are %s", result.EngineVersion, openClawSupportedVersions())
	} else {
		result.Ready = true
		result.Reason = "OpenClaw " + result.EngineVersion + " reports a skill placed in its skills directory as ready, and the report needs no gateway"
	}
	return result, nil
}

func packageVersionInParents(binary, name string) string {
	for dir, n := filepath.Dir(binary), 0; n < 12; n++ {
		if version := packageVersion(filepath.Join(dir, "package.json"), name); version != "" {
			return version
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}
