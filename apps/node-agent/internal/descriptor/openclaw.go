package descriptor

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// openclawDescriptor implements Descriptor for the OpenClaw agent harness.
// The OpenClaw home directory layout is:
//
//	~/.openclaw/
//	  openclaw.json          ← main config
//	  agents/
//	    <name>/              ← one dir per subagent (deity names: hanuman, kubera, …)
//	  workspace/             ← main workspace
//	    agent-workspaces/
//	      <name>/            ← per-subagent workspace (nested inside main workspace)
//	  logs/                  ← log files
//
// A single gateway process (`node … openclaw/dist/index.js gateway`) serves all
// subagents; per-subagent process state is not separable.
type openclawDescriptor struct {
	home     string // absolute path to the .openclaw home directory
	startCmd string

	// ACP bridge settings — see OpenClawConfig. All optional.
	gatewayURL   string
	tokenFile    string
	sessionLabel string

	// gatewayUp probes whether a local OpenClaw Gateway is running. It is a
	// field so tests can declare the answer without spawning or pgrep-ing a
	// process; production wiring in NewOpenClawFrom uses openclawGatewayPID.
	gatewayUp func() bool
}

// OpenClawConfig carries everything the descriptor needs. Zero values are valid:
// an empty GatewayURL/TokenFile means "let openclaw resolve it from its own
// config", which is what a default local install wants.
type OpenClawConfig struct {
	Home         string // default: <user home>/.openclaw
	StartCmd     string // lifecycle Start (existing behaviour)
	GatewayURL   string // → --url
	TokenFile    string // → --token-file  (never --token)
	SessionLabel string // session component of agent:<name>:<label>; default "main"
}

// NewOpenClawFrom returns a Descriptor for the OpenClaw harness configured by cfg.
func NewOpenClawFrom(cfg OpenClawConfig) Descriptor {
	home := cfg.Home
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			userHome = "."
		}
		home = filepath.Join(userHome, ".openclaw")
	}
	label := cfg.SessionLabel
	if label == "" {
		label = "main"
	}
	return &openclawDescriptor{
		home:         home,
		startCmd:     cfg.StartCmd,
		gatewayURL:   cfg.GatewayURL,
		tokenFile:    cfg.TokenFile,
		sessionLabel: label,
		gatewayUp:    func() bool { _, err := openclawGatewayPID(); return err == nil },
	}
}

// NewOpenClaw returns a Descriptor for the OpenClaw harness.
// home is the path to the OpenClaw home directory (e.g. "~/.openclaw").
// If home is empty it defaults to $HOME/.openclaw.
func NewOpenClaw(home string, startCmd ...string) Descriptor {
	var cmd string
	if len(startCmd) > 0 {
		cmd = startCmd[0]
	}
	return NewOpenClawFrom(OpenClawConfig{Home: home, StartCmd: cmd})
}

// Harness returns the harness identifier.
func (o *openclawDescriptor) Harness() string { return "openclaw" }

// Detect discovers all OpenClaw stations. It returns empty (nil-safe) if the
// home directory does not exist.
func (o *openclawDescriptor) Detect() ([]Station, error) {
	if _, err := os.Stat(o.home); os.IsNotExist(err) {
		return []Station{}, nil
	}

	// "acp" is advertised because *openclawDescriptor implements ACPCommander.
	caps := []string{"health", "logs", "fs.read", "fs.write", "terminal", "lifecycle", "cleanup", "acp"}

	// Root workspace: prefer <home>/workspace if it exists, else fall back to <home>.
	rootWs := o.resolveRootWorkspace()
	rootWsCopy := rootWs

	stations := []Station{
		{
			Key:           "openclaw",
			Harness:       "openclaw",
			Kind:          "composite",
			DisplayName:   "OpenClaw",
			ParentKey:     nil,
			WorkspacePath: &rootWsCopy,
			Capabilities:  caps,
		},
	}

	agentsDir := filepath.Join(o.home, "agents")
	entries, err := os.ReadDir(agentsDir)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("openclaw: reading agents dir: %w", err)
	}

	parentKey := "openclaw"
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		key := "openclaw:" + name
		wsPath := o.resolveAgentWorkspace(name)
		wsCopy := wsPath
		agentConfigDir := filepath.Join(agentsDir, name)
		stations = append(stations, Station{
			Key:           key,
			Harness:       "openclaw",
			Kind:          "composite",
			DisplayName:   name,
			ParentKey:     &parentKey,
			WorkspacePath: &wsCopy,
			Capabilities:  caps,
			MatrixId:      MatrixIDFromProfile(agentConfigDir, "id.agentpod.dev"),
		})
	}

	return stations, nil
}

// resolveRootWorkspace returns <home>/workspace if it exists, else <home>.
func (o *openclawDescriptor) resolveRootWorkspace() string {
	ws := filepath.Join(o.home, "workspace")
	if _, err := os.Stat(ws); err == nil {
		return ws
	}
	return o.home
}

// resolveAgentWorkspace returns the workspace for a named subagent.
// Prefers <home>/workspace/agent-workspaces/<name>; falls back to
// <home>/agents/<name> if the nested workspace dir is absent.
func (o *openclawDescriptor) resolveAgentWorkspace(name string) string {
	nested := filepath.Join(o.home, "workspace", "agent-workspaces", name)
	if _, err := os.Stat(nested); err == nil {
		return nested
	}
	return filepath.Join(o.home, "agents", name)
}

// workspaceFor maps a station key to its workspace root path.
func (o *openclawDescriptor) workspaceFor(key string) (string, error) {
	if key == "openclaw" {
		return o.resolveRootWorkspace(), nil
	}
	if strings.HasPrefix(key, "openclaw:") {
		name := strings.TrimPrefix(key, "openclaw:")
		if name == "" {
			return "", fmt.Errorf("openclaw: empty agent name in key %q", key)
		}
		return o.resolveAgentWorkspace(name), nil
	}
	return "", fmt.Errorf("openclaw: unrecognized key %q", key)
}

// ACPCommand implements ACPCommander. OpenClaw speaks ACP natively via
// `openclaw acp` (OpenClaw ≥ 2026.1.20), which is a bridge to the OpenClaw
// Gateway rather than a self-contained runtime: it dials the Gateway over
// WebSocket and addresses work by session key agent:<name>:<session>.
// Everything except --session is optional so a default local install (Gateway
// running, openclaw's own config) needs no node configuration at all.
func (o *openclawDescriptor) ACPCommand(key string) ([]string, string, []string, error) {
	workspace, err := o.workspaceFor(key)
	if err != nil {
		return nil, "", nil, err
	}

	// A configured URL points at a remote Gateway, so the local probe says
	// nothing; without one, a dead local Gateway means the bridge would start,
	// fail to dial, and leave the user waiting on the hub's handshake deadline.
	// Failing here turns that into an immediate, actionable message.
	if o.gatewayURL == "" && !o.gatewayUp() {
		return nil, "", nil, fmt.Errorf("openclaw: the OpenClaw gateway isn't running on this node — start it before opening a session")
	}

	agent := "main"
	if name := strings.TrimPrefix(key, "openclaw:"); name != key && name != "" {
		agent = name
	}
	label := o.sessionLabel
	if label == "" {
		label = "main"
	}

	// --no-prefix-cwd: the bridge otherwise prefixes every prompt with the
	// working directory, which is redundant here — the station IS its workspace
	// and we already set cmd.Dir — and it pollutes the transcript.
	argv := []string{"openclaw", "acp", "--no-prefix-cwd"}
	if o.gatewayURL != "" {
		argv = append(argv, "--url", o.gatewayURL)
	}
	if o.tokenFile != "" {
		// --token-file only, never --token: argv is world-readable via ps.
		argv = append(argv, "--token-file", o.tokenFile)
	}
	argv = append(argv, "--session", fmt.Sprintf("agent:%s:%s", agent, label))

	return argv, workspace, nil, nil
}

// Health returns a best-effort liveness/resource snapshot for a station.
//
// Process liveness is checked against the gateway process or the user systemd
// unit openclaw-gateway.service. Because all subagents share a single gateway
// process, per-subagent process state is not separable; Health.Note is always
// set for subagent keys to communicate this.
func (o *openclawDescriptor) Health(key string) (Health, error) {
	workspace, err := o.workspaceFor(key)
	if err != nil {
		return Health{}, err
	}

	health := Health{}

	// Disk usage from the shared async cache — never walk on the request path.
	health.DiskBytes = diskUsage(workspace)

	// Best-effort process check against the gateway.
	running, note := openclawGatewayRunning()
	health.Running = running

	// Gateway metrics: best-effort — populate PID/CPU/memory/uptime when the
	// gateway is running. Any failure (pid lookup, ps, parse) is silently
	// swallowed so Health() never crashes.
	if running {
		if pid, pidErr := openclawGatewayPID(); pidErr == nil {
			if cpuPct, memBytes, uptimeSec := gatherPidMetrics(pid); cpuPct != nil {
				health.PID = &pid
				health.CpuPct = cpuPct
				health.MemBytes = memBytes
				health.UptimeSec = uptimeSec
				note = fmt.Sprintf("shared gateway (PID %d)", pid)
			}
		}
	}

	if key != "openclaw" {
		// Per-subagent: the gateway serves all agents; state is not separable.
		subNote := "gateway process shared across all subagents"
		if note != "" {
			subNote = note
		}
		health.Note = &subNote
	} else if note != "" {
		health.Note = &note
	}

	return health, nil
}

// parsePsMetrics parses one line of `ps -p <pid> -o %cpu=,rss=,etime=` output.
// Fields are whitespace-split: cpu%, rssKB, etime.
// etime formats accepted: MM:SS, HH:MM:SS, D-HH:MM:SS.
// Returns an error on malformed input.
func parsePsMetrics(out string) (cpuPct float64, rssKB int64, uptimeSec int64, err error) {
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) != 3 {
		err = fmt.Errorf("parsePsMetrics: expected 3 fields, got %d: %q", len(fields), out)
		return
	}
	cpuPct, err = strconv.ParseFloat(fields[0], 64)
	if err != nil {
		err = fmt.Errorf("parsePsMetrics: cpu: %w", err)
		return
	}
	rssKB, err = strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		err = fmt.Errorf("parsePsMetrics: rss: %w", err)
		return
	}
	uptimeSec, err = parseEtime(fields[2])
	if err != nil {
		err = fmt.Errorf("parsePsMetrics: etime: %w", err)
	}
	return
}

// parseEtime converts a ps etime string to seconds.
// Accepted formats: MM:SS, HH:MM:SS, D-HH:MM:SS.
func parseEtime(s string) (int64, error) {
	var days int64
	if idx := strings.Index(s, "-"); idx != -1 {
		d, err := strconv.ParseInt(s[:idx], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: days: %w", err)
		}
		days = d
		s = s[idx+1:]
	}

	parts := strings.Split(s, ":")
	switch len(parts) {
	case 2: // MM:SS
		mm, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: minutes: %w", err)
		}
		ss, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: seconds: %w", err)
		}
		return days*86400 + mm*60 + ss, nil
	case 3: // HH:MM:SS
		hh, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: hours: %w", err)
		}
		mm, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: minutes: %w", err)
		}
		ss, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: seconds: %w", err)
		}
		return days*86400 + hh*3600 + mm*60 + ss, nil
	default:
		return 0, fmt.Errorf("parseEtime: unexpected etime format %q", s)
	}
}

// openclawGatewayRunning checks whether the OpenClaw gateway process is running.
// It tries (in order):
//  1. systemctl --user is-active openclaw-gateway.service
//  2. pgrep -f "openclaw.*gateway"
//
// Returns running=false and a non-empty note when neither check can be performed.
func openclawGatewayRunning() (running bool, note string) {
	// Try systemctl --user first (Linux with user systemd units).
	cmd := exec.Command("systemctl", "--user", "is-active", "openclaw-gateway.service")
	if out, err := cmd.Output(); err == nil {
		state := strings.TrimSpace(string(out))
		return state == "active", ""
	}

	// Fall back to pgrep -f for the gateway process pattern.
	pgrepCmd := exec.Command("pgrep", "-f", "openclaw.*gateway")
	if err := pgrepCmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() == 1 {
				// pgrep exit 1 = no match (process not found), not an error.
				return false, ""
			}
		}
		// pgrep not available or unexpected error.
		return false, "process check unavailable"
	}
	return true, ""
}

// openclawGatewayPID returns the PID of the OpenClaw gateway process, or an
// error if no matching process is found.
func openclawGatewayPID() (int, error) {
	out, err := exec.Command("pgrep", "-f", "openclaw.*gateway").Output()
	if err != nil {
		return 0, fmt.Errorf("no openclaw gateway process found")
	}
	lines := strings.Fields(strings.TrimSpace(string(out)))
	if len(lines) == 0 {
		return 0, fmt.Errorf("no openclaw gateway process found")
	}
	return strconv.Atoi(lines[0])
}

// Stop implements Lifecycle. It first tries systemctl --user stop; if that
// fails it falls back to finding the gateway PID via pgrep and sending
// SIGTERM (escalating to SIGKILL after LifecycleGracePeriod).
func (o *openclawDescriptor) Stop(key string) error {
	// Prefer systemctl stop (no-ops gracefully if service not configured).
	if err := exec.Command("systemctl", "--user", "stop", "openclaw-gateway.service").Run(); err == nil {
		return nil
	}
	pid, err := openclawGatewayPID()
	if err != nil {
		return fmt.Errorf("openclaw: stop %q: %w", key, err)
	}
	return stopProcess(pid, LifecycleGracePeriod)
}

// Start implements Lifecycle. It runs the configured start command in a new
// session (detached). If no start command is set it returns a descriptive error.
//
// Configure the start command by passing it to NewOpenClaw or by setting
// openclawStartCmd in the node config file.
func (o *openclawDescriptor) Start(key string) error {
	if o.startCmd == "" {
		return fmt.Errorf("no start command configured for openclaw (set openclawStartCmd in node config)")
	}
	cmd := exec.Command("sh", "-c", o.startCmd)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}

// ListDir lists the directory at rel (relative to the station's workspace).
func (o *openclawDescriptor) ListDir(key, rel string) ([]FsEntry, error) {
	workspace, err := o.workspaceFor(key)
	if err != nil {
		return nil, err
	}

	target, err := safeJoin(workspace, rel)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fmt.Errorf("openclaw: ListDir %q: %w", target, err)
	}

	result := make([]FsEntry, 0, len(entries))
	for _, entry := range entries {
		fsEntry := FsEntry{
			Name: entry.Name(),
			Path: filepath.Join(rel, entry.Name()),
		}
		switch {
		case entry.Type()&fs.ModeSymlink != 0:
			fsEntry.Type = "symlink"
		case entry.IsDir():
			fsEntry.Type = "dir"
		default:
			fsEntry.Type = "file"
			info, err := entry.Info()
			if err == nil {
				sz := info.Size()
				fsEntry.Size = &sz
				mod := info.ModTime().UTC().Format(time.RFC3339)
				fsEntry.Modified = &mod
			}
		}
		result = append(result, fsEntry)
	}
	return result, nil
}

// ReadFile reads up to maxBytes from path within the station's workspace.
// It returns the raw bytes, encoding hint ("" means auto-detect in handler),
// whether the file was truncated, and any error.
func (o *openclawDescriptor) ReadFile(key, rel string, maxBytes int64) ([]byte, string, bool, error) {
	workspace, err := o.workspaceFor(key)
	if err != nil {
		return nil, "", false, err
	}

	target, err := safeJoin(workspace, rel)
	if err != nil {
		return nil, "", false, err
	}

	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}

	f, err := os.Open(target)
	if err != nil {
		return nil, "", false, fmt.Errorf("openclaw: ReadFile %q: %w", target, err)
	}
	defer f.Close()

	// Read up to maxBytes+1 so we can detect truncation.
	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, "", false, fmt.Errorf("openclaw: ReadFile read %q: %w", target, err)
	}

	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}

	return buf[:n], "", truncated, nil
}

// TailLogs emits existing log content from <home>/logs and, if follow is true,
// polls for appends until ctx is cancelled.
//
// Only files with log-ish extensions (.log, .txt) are emitted; other files
// (e.g. binary or config files that may appear in the logs dir) are skipped.
func (o *openclawDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	logsDir := filepath.Join(o.home, "logs")
	collect := func() []string { return collectOpenClawLogFiles(logsDir) }
	logFiles := collect()

	if !follow {
		// One-shot: emit the last N lines of existing content.
		return emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit)
	}

	// Follow mode: wait for a log file to exist (a harness that hasn't
	// written logs yet must not close the stream immediately), then emit the
	// last N lines and poll for appends.
	logFiles = waitForLogFiles(ctx, collect)
	if err := emitLastNLines(logFiles, tailDefaultN, tailMaxBytes, emit); err != nil {
		return err
	}

	// Track offsets per file for incremental reads.
	offsets := make(map[string]int64, len(logFiles))
	for _, f := range logFiles {
		info, err := os.Stat(f)
		if err == nil {
			offsets[f] = info.Size()
		}
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			logFiles = collectOpenClawLogFiles(logsDir)
			for _, path := range logFiles {
				off := offsets[path]
				n, err := emitLogFileFrom(path, off, emit)
				if err != nil {
					continue // best effort
				}
				offsets[path] = off + n
			}
		}
	}
}

// CleanPlan returns the cleanable items for the OpenClaw station.
// Cleanable: "logs" subdirectory within the workspace + *.log files at root.
func (o *openclawDescriptor) CleanPlan(key string) ([]CleanItem, error) {
	workspace, err := o.workspaceFor(key)
	if err != nil {
		return nil, err
	}
	return cleanPlanCommon(workspace, []string{"logs"})
}

// CleanApply removes selected cleanable paths from the OpenClaw workspace.
func (o *openclawDescriptor) CleanApply(key string, paths []string) (int64, error) {
	workspace, err := o.workspaceFor(key)
	if err != nil {
		return 0, err
	}
	plan, err := o.CleanPlan(key)
	if err != nil {
		return 0, err
	}
	return cleanApplyCommon(workspace, paths, plan)
}

// isLogFile reports whether name has a log-ish extension (.log or .txt).
func isLogFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".log" || ext == ".txt"
}

// collectOpenClawLogFiles walks logsDir and returns paths of log-ish files.
// Missing directory is silently skipped.
func collectOpenClawLogFiles(logsDir string) []string {
	var files []string
	_ = filepath.WalkDir(logsDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && isLogFile(d.Name()) {
			files = append(files, path)
		}
		return nil
	})
	return files
}
