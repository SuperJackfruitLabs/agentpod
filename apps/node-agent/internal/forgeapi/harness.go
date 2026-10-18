package forgeapi

// Routing a station's harness through ITS OWN stk instance.
//
// Three ways a harness gets the environment (env.go):
//   - ACP sessions and terminals the node spawns: the environment is computed at spawn time from the
//     station's instance (EnvForKey) and handed to the process; nothing is written to disk.
//   - A harness a systemd unit starts does not inherit what the node hands a spawn. For it the node
//     writes, per station and unit, an environment file at a node-owned path (mode 0600, owned by
//     the station's agent uid) and a unit drop-in that reads it (EnvironmentFile=-<path>). A running
//     process keeps the environment it started with, so when the environment changed under a
//     running unit the ack says `needsRestart` and the node does NOT restart it: it cannot know the
//     agent is not mid-turn, and the operator or hub can restart it from lifecycle.
//   - The proxy credential is in the environment and the env file, and nowhere else: not in a log,
//     an error, an ack, the registry or the drop-in.
//
// Each station gets only its own instance's proxy URL and key. The wiring refuses to write a file
// for a station whose agent uid is the node's own (a file the node itself, and every other station
// on the default mapping, can read isolates nothing) unless the operator acknowledged shared uids.

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultHarnessEnvRoot holds one directory per instance: <root>/<instance name>/<unit>.env.
const DefaultHarnessEnvRoot = "/var/lib/agentpod/forge-api/harness-env"

// dropInName is the file the node writes into a unit's drop-in directory.
const dropInName = "90-agentpod-forge.conf"

const spawnEnvTimeout = 15 * time.Second

// HarnessWiring configures the harness wiring of StationInstances. Every function is a seam: the
// node supplies the systemd ones; tests supply fakes.
type HarnessWiring struct {
	// Root is where the env files live; DefaultHarnessEnvRoot when empty.
	Root string
	// Units returns the systemd units that start the harness of the station with this key (empty:
	// started by the node itself, wired at spawn only).
	Units func(stationKey string) []string
	// DropInDir returns the drop-in directory of a unit (<unit>.d).
	DropInDir func(unit string) string
	// Running reports whether the unit is active.
	Running func(ctx context.Context, unit string) bool
	// DaemonReload tells systemd that unit files changed.
	DaemonReload func(ctx context.Context) error
	// Chown sets a directory's owner without following a symlink (os.Lchown when nil).
	Chown func(path string, uid, gid int) error
	// FChown sets an open file's owner (f.Chown, an fchown on the descriptor, when nil).
	FChown func(f *os.File, uid, gid int) error
	// UnitEnv returns the unit's own environment (NAME=value entries) so the node can see a proxy
	// variable the unit already sets; nil when it cannot be read.
	UnitEnv func(ctx context.Context, unit string) []string
}

func (h *HarnessWiring) root() string {
	if h.Root != "" {
		return h.Root
	}
	return DefaultHarnessEnvRoot
}

func (h *HarnessWiring) chown(path string, uid, gid int) error {
	if h.Chown != nil {
		return h.Chown(path, uid, gid)
	}
	return os.Lchown(path, uid, gid)
}

func (h *HarnessWiring) fchown(f *os.File, uid, gid int) error {
	if h.FChown != nil {
		return h.FChown(f, uid, gid)
	}
	return f.Chown(uid, gid)
}

func (h *HarnessWiring) units(key string) []string {
	if h.Units == nil || key == "" {
		return nil
	}
	return h.Units(key)
}

var unitNameRE = regexp.MustCompile(`^[A-Za-z0-9:_.@-]{1,200}\.(service)$`)

// ---- the environment of one station ----

// stationEnv is the broker environment of the station st serves and the forge hosts its grants
// reach. nil when the station holds no grant of its own (a shared base service alone does not make
// a station a forge station). The client is the station's own instance's.
func (m *StationInstances) stationEnv(ctx context.Context, st *stationState) (map[string]string, []string, error) {
	data, _, err := readPolicyFile(st.inst.ConfigPath)
	if err != nil {
		return nil, nil, coded("policy-read-failed", err)
	}
	entries, err := ManagedEntries(data)
	if err != nil {
		return nil, nil, coded("policy-invalid", err)
	}
	var hosts []string
	seen := map[string]bool{}
	own := 0
	for _, e := range entries {
		if e.Station != st.inst.Station {
			continue
		}
		own++
		if h := strings.ToLower(e.Host); h != "" && !seen[h] {
			seen[h] = true
			hosts = append(hosts, h)
		}
	}
	if own == 0 {
		return nil, nil, nil
	}
	sort.Strings(hosts)
	env, err := BrokerEnv(ctx, st.svc.NewClient(), st.inst.Station)
	if err != nil {
		return nil, nil, err
	}
	if len(env) == 0 {
		return nil, nil, nil
	}
	if err := checkOwnProxy(env, st.inst); err != nil {
		return nil, nil, err
	}
	return env, hosts, nil
}

// checkOwnProxy refuses an environment whose proxy is not this station's instance: whatever stk
// said, a harness is never handed another instance's proxy URL and key. The error names no URL.
func checkOwnProxy(env map[string]string, inst Instance) error {
	for _, k := range proxyURLVars {
		v := env[k]
		if v == "" {
			continue
		}
		u, err := url.Parse(v)
		if err != nil || u.Port() != strconv.Itoa(inst.Port) || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
			return codedf("broker-env-mismatch", "stk reported a proxy that is not this station's instance (expected the loopback port %d)", inst.Port)
		}
	}
	return nil
}

// EnvForKey is the broker environment for the harness the node is about to spawn for the station
// with this key, and the forge hosts it reaches. nil for a station with no instance or no grant of
// its own, and when the environment cannot be had (logged, never with a value): the harness then
// starts as it would have, with no route to the forge rather than a wrong one.
func (m *StationInstances) EnvForKey(key string) (map[string]string, []string) {
	if m.cfg.Harness == nil || strings.TrimSpace(key) == "" {
		return nil, nil
	}
	recs, err := m.readRecords()
	if err != nil {
		m.warnOnce("registry", "forgeapi: no broker environment for spawns: "+clean(err.Error()))
		return nil, nil
	}
	station, n := stationOfKey(recs, key)
	if n > 1 {
		// Never pick one: whichever the map yields first would hand one station another's proxy.
		m.warnOnce("dupkey|"+key, fmt.Sprintf("forgeapi: more than one station claims the key %s; none of them gets a broker environment until the registry is fixed", clean(key)))
		return nil, nil
	}
	if station == "" {
		return nil, nil
	}
	st, _, err := m.lookup(station, false)
	if err != nil || st == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), spawnEnvTimeout)
	defer cancel()
	env, hosts, err := m.stationEnv(ctx, st)
	if err != nil {
		logf("forgeapi: station %s starts without its broker environment: %v", clean(station), clean(err.Error()))
		return nil, nil
	}
	return env, hosts
}

func (m *StationInstances) warnOnce(id, msg string) {
	m.mu.Lock()
	seen := m.warned["once:"+id]
	m.warned["once:"+id] = true
	m.mu.Unlock()
	if !seen {
		logf("%s", msg)
	}
}

// ---- systemd-started harnesses ----

// recordKey remembers the station's node key in the registry.
func (m *StationInstances) recordKey(station, key string) error {
	if strings.TrimSpace(key) == "" {
		return nil
	}
	return m.updateRecords(func(recs map[string]record) (bool, error) {
		if holder := keyHolder(recs, key, station); holder != "" {
			return false, codedf("station-key-in-use", "the key %s already belongs to another station on this node", clean(key))
		}
		r, ok := recs[station]
		if !ok || r.StationKey == key {
			return false, nil
		}
		r.StationKey = key
		recs[station] = r
		return true, nil
	})
}

// stationOfKey returns the station recorded for key and how many records claim it.
func stationOfKey(recs map[string]record, key string) (string, int) {
	station, n := "", 0
	for st, r := range recs {
		if r.StationKey == key {
			station = st
			n++
		}
	}
	return station, n
}

// keyHolder is a station other than except that holds key ("" when none does).
func keyHolder(recs map[string]record, key, except string) string {
	for st, r := range recs {
		if st != except && r.StationKey == key {
			return st
		}
	}
	return ""
}

// checkKeyFree refuses a deliver whose key another station holds, before anything is created.
func (m *StationInstances) checkKeyFree(station, key string) error {
	if m.cfg.Harness == nil || strings.TrimSpace(key) == "" {
		return nil
	}
	recs, err := m.readRecords()
	if err != nil {
		return err
	}
	if keyHolder(recs, key, station) != "" {
		return codedf("station-key-in-use", "the key %s already belongs to another station on this node", clean(key))
	}
	return nil
}

func (m *StationInstances) keyOf(station string) string {
	recs, err := m.readRecords()
	if err != nil {
		return ""
	}
	return recs[station].StationKey
}

// wireResult is what a wiring pass did: whether a running unit needs a restart to see it, and
// which units now carry the station's environment file.
type wireResult struct {
	restart bool
	wired   []string
}

// wireStation brings the station's systemd harness files in line with its grants: written when it
// holds any, removed when it holds none. A unit whose own environment already sets a proxy
// variable gets nothing (a half-applied broker is worse than none) and the reason is kept for
// WiringBlocked. Idempotent. key, when not empty, is recorded first.
func (m *StationInstances) wireStation(ctx context.Context, st *stationState, key string) (wireResult, error) {
	h := m.cfg.Harness
	if h == nil {
		return wireResult{}, nil
	}
	m.wiringMu.Lock()
	defer m.wiringMu.Unlock()
	station := st.inst.Station
	if key != "" {
		if err := m.recordKey(station, key); err != nil {
			return wireResult{}, err
		}
	} else {
		key = m.keyOf(station)
	}
	env, hosts, err := m.stationEnv(ctx, st)
	if err != nil {
		return wireResult{}, coded("harness-wiring-failed", err)
	}
	if env == nil {
		m.setBlocked(station, "unit", "")
		restart, err := m.unwireInstance(ctx, st.inst)
		return wireResult{restart: restart}, err
	}
	units := h.units(key)
	for _, u := range units {
		if !unitNameRE.MatchString(u) {
			return wireResult{}, codedf("harness-wiring-failed", "refusing unit name %q", clean(u))
		}
		if other := m.otherInstanceHoldsUnit(st.inst, u); other {
			return wireResult{}, codedf("harness-unit-in-use", "the unit %s already carries another station's environment file; one unit serves one station", clean(u))
		}
	}
	want := map[string]bool{}
	var res wireResult
	changedAny := false
	var reasons []string
	if len(units) > 0 {
		uid, err := m.harnessOwner(station)
		if err != nil {
			return wireResult{}, err
		}
		dir := filepath.Join(h.root(), st.inst.Name)
		if err := m.ensureWiringDir(dir, uid); err != nil {
			return wireResult{}, coded("harness-wiring-failed", err)
		}
		for _, u := range units {
			var unitEnv []string
			if h.UnitEnv != nil {
				unitEnv = h.UnitEnv(ctx, u)
			}
			_, blocked := ApplyBrokerEnv(unitEnv, env, hosts...)
			if len(blocked) > 0 {
				reasons = append(reasons, fmt.Sprintf("unit %s already sets %s", u, strings.Join(blocked, ", ")))
				warnOnceByName("blocked|"+station+"|"+u+"|"+strings.Join(blocked, ","), "forgeapi: WARNING: the unit %s of station %s already sets %s, so it gets NO broker environment file; remove the variable from the unit", clean(u), clean(station), strings.Join(blocked, ", "))
				continue
			}
			want[u] = true
			path := filepath.Join(dir, u+".env")
			changed, err := m.writeEnvFile(path, renderEnvFile(unitAdd(env, unitEnv)), uid)
			if err != nil {
				return wireResult{}, coded("harness-wiring-failed", err)
			}
			dchanged, err := m.writeDropIn(u, path)
			if err != nil {
				return wireResult{}, coded("harness-wiring-failed", err)
			}
			res.wired = append(res.wired, u)
			if changed || dchanged {
				changedAny = true
				if h.Running != nil && h.Running(ctx, u) {
					res.restart = true
					logf("forgeapi: the harness unit %s of station %s is running and needs a restart to use its changed broker environment", clean(u), clean(station))
				}
			}
		}
	}
	m.setBlocked(station, "unit", strings.Join(reasons, "; "))
	// a unit that no longer starts this station's harness, or is blocked, leaves nothing behind
	staleRestart, staleChanged, err := m.removeStale(ctx, st.inst, want)
	if err != nil {
		return wireResult{}, err
	}
	if staleRestart {
		logf("forgeapi: a harness unit of station %s is running and needs a restart to drop its broker environment", clean(station))
	}
	if changedAny || staleChanged {
		if h.DaemonReload != nil {
			if err := h.DaemonReload(ctx); err != nil {
				return wireResult{}, coded("harness-wiring-failed", fmt.Errorf("systemd daemon-reload: %w", err))
			}
		}
	}
	res.restart = res.restart || staleRestart
	return res, nil
}

// unitAdd is the broker environment minus what the unit already sets under the same name (a CA
// variable it chose itself wins, as at spawn).
func unitAdd(env map[string]string, unitEnv []string) map[string]string {
	set := map[string]bool{}
	for _, e := range unitEnv {
		set[strings.SplitN(e, "=", 2)[0]] = true
	}
	out := make(map[string]string, len(env))
	for k, v := range env {
		if !set[k] && !isNoProxy(k) {
			out[k] = v
		}
	}
	return out
}

// otherInstanceHoldsUnit reports whether another instance's directory already has an env file for
// the unit: two stations must never share one unit's drop-in.
func (m *StationInstances) otherInstanceHoldsUnit(inst Instance, unit string) bool {
	root := m.cfg.Harness.root()
	entries, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Name() == inst.Name || !e.IsDir() {
			continue
		}
		if _, err := os.Lstat(filepath.Join(root, e.Name(), unit+".env")); err == nil {
			return true
		}
	}
	return false
}

// ---- what blocks a station's wiring (for the verify and status acks) ----

func (m *StationInstances) setBlocked(station, source, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.blocked == nil {
		m.blocked = map[string]map[string]string{}
	}
	if reason == "" {
		if b := m.blocked[station]; b != nil {
			delete(b, source)
			if len(b) == 0 {
				delete(m.blocked, station)
			}
		}
		return
	}
	if m.blocked[station] == nil {
		m.blocked[station] = map[string]string{}
	}
	m.blocked[station][source] = reason
}

// NoteBlocked records (or, with no names, clears) that the spawn for the station with this key was
// left without the broker because the descriptor's own environment sets a proxy variable. Names
// only, never values.
func (m *StationInstances) NoteBlocked(key string, names []string) {
	if m.cfg.Harness == nil {
		return
	}
	recs, err := m.readRecords()
	if err != nil {
		return
	}
	station, n := stationOfKey(recs, key)
	if n != 1 {
		return
	}
	m.dropProbe(station)
	reason := ""
	if len(names) > 0 {
		reason = "the harness environment already sets " + strings.Join(names, ", ")
	}
	m.setBlocked(station, "spawn", reason)
}

// WiringBlocked is why the station's harness is not routed through its broker (a proxy variable
// already set by the harness's environment or unit), or "" when nothing blocks it. Names only.
func (m *StationInstances) WiringBlocked(station string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	b := m.blocked[station]
	var parts []string
	for _, src := range []string{"spawn", "unit"} {
		if r := b[src]; r != "" {
			parts = append(parts, r)
		}
	}
	return strings.Join(parts, "; ")
}

// harnessOwner is the uid that owns the station's env file, refusing the node's own uid unless the
// operator acknowledged that agents share uids.
func (m *StationInstances) harnessOwner(station string) (int, error) {
	uids := m.cfg.AgentUIDs(station)
	if len(uids) == 0 {
		return 0, codedf("harness-uid-unknown", "no agent uid is known for this station, so its harness environment file cannot be given an owner")
	}
	if !m.cfg.AllowSharedAgentUID {
		for _, u := range uids {
			if u == m.env.euid {
				return 0, codedf("harness-uid-is-node", "this station's agents run as uid %d, the uid the node itself runs as, so a file the node writes for them isolates nothing from the node or from other stations; give the station its own uid (forgeApi.stationUids) or acknowledge it with allowSharedAgentUid", u)
			}
		}
	}
	return uids[0], nil
}

// requireDir makes sure path is a real directory (not a symlink), creating it with mode when
// absent. The node runs as root: a symlink here would send its chmod and chown elsewhere.
func requireDir(path string, mode os.FileMode) error {
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.Mkdir(path, mode); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		fi, err = os.Lstat(path)
		if err != nil {
			return err
		}
	case err != nil:
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("refusing %s: it is not a plain directory (a symlink or file)", path)
	}
	return nil
}

func (m *StationInstances) ensureWiringDir(dir string, uid int) error {
	h := m.cfg.Harness
	if err := requireDir(h.root(), 0o711); err != nil {
		return err
	}
	if err := os.Chmod(h.root(), 0o711); err != nil {
		return err
	}
	if err := requireDir(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	return h.chown(dir, uid, -1)
}

// readRegular returns the file's content; a missing file is (nil, nil). A symlink or anything that
// is not a regular file is refused: the directory belongs to the agent's uid, which can plant one.
func readRegular(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("refusing %s: it is not a regular file (a symlink?)", path)
	}
	return os.ReadFile(path)
}

// renderEnvFile renders systemd EnvironmentFile syntax: NAME="value", with the characters that
// matter inside double quotes escaped. Sorted, so an unchanged environment is an unchanged file.
func renderEnvFile(env map[string]string) []byte {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("# managed by agentpod-node (forge API): this station's stk proxy. Holds the proxy credential; do not copy.\n")
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", "", "\r", "")
	for _, k := range keys {
		b.WriteString(k + `="` + r.Replace(env[k]) + "\"\n")
	}
	return []byte(b.String())
}

// writeEnvFile writes the file 0600 owned by uid, atomically, and reports whether its content
// changed.
//
// The directory is owned by the agent's uid, so the agent can plant a symlink in it. The node
// therefore never chowns or opens a path there by name: the temporary file is created with O_EXCL
// (which does not follow a link), chmodded and chowned through its OPEN DESCRIPTOR before any
// content is written, and renamed over the final name (rename replaces a link, it does not follow
// it, and keeps the owner). An existing symlink at the final name is refused. The temp file stays
// in the agent's directory rather than a root-owned staging directory because rename needs one
// filesystem and the node cannot know that /var/lib/agentpod and the instance directory are.
func (m *StationInstances) writeEnvFile(path string, data []byte, uid int) (bool, error) {
	h := m.cfg.Harness
	prev, err := readRegular(path)
	if err != nil {
		return false, err
	}
	changed := string(prev) != string(data)
	tmp, err := os.CreateTemp(filepath.Dir(path), ".env-*.tmp")
	if err != nil {
		return false, err
	}
	name := tmp.Name()
	fail := func(err error) (bool, error) { _ = tmp.Close(); _ = os.Remove(name); return false, err }
	if err := tmp.Chmod(0o600); err != nil {
		return fail(err)
	}
	if err := h.fchown(tmp, uid, -1); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return false, err
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return false, err
	}
	return changed, nil
}

// writeDropIn makes the unit read the env file. The drop-in names the file and holds no secret.
func (m *StationInstances) writeDropIn(unit, envPath string) (bool, error) {
	h := m.cfg.Harness
	if h.DropInDir == nil {
		return false, errors.New("no drop-in directory is configured")
	}
	dir := h.DropInDir(unit)
	path := filepath.Join(dir, dropInName)
	data := []byte("# managed by agentpod-node (forge API); do not edit\n[Service]\nEnvironmentFile=-" + envPath + "\n")
	prev, err := readRegular(path)
	if err != nil {
		return false, err
	}
	if string(prev) == string(data) {
		return false, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	return true, writeFileAtomic(path, data, 0o644)
}

// removeStale removes the instance's env files (and their drop-ins) of units not in keep.
func (m *StationInstances) removeStale(ctx context.Context, inst Instance, keep map[string]bool) (restart, changed bool, err error) {
	h := m.cfg.Harness
	dir := filepath.Join(h.root(), inst.Name)
	if fi, lerr := os.Lstat(dir); lerr == nil && !fi.IsDir() {
		return false, false, coded("harness-wiring-failed", fmt.Errorf("refusing %s: not a plain directory", dir))
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return false, false, nil
	}
	if err != nil {
		return false, false, coded("harness-wiring-failed", err)
	}
	for _, e := range entries {
		unit, ok := strings.CutSuffix(e.Name(), ".env")
		if !ok || e.IsDir() || !unitNameRE.MatchString(unit) || keep[unit] {
			continue // only files the node itself writes are ever removed
		}
		if h.Running != nil && h.Running(ctx, unit) {
			restart = true
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, false, coded("harness-wiring-failed", err)
		}
		if h.DropInDir != nil {
			d := h.DropInDir(unit)
			if err := os.Remove(filepath.Join(d, dropInName)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return false, false, coded("harness-wiring-failed", err)
			}
			_ = os.Remove(d) // only when empty
		}
		changed = true
	}
	_ = os.Remove(dir) // only when empty
	return restart, changed, nil
}

// unwireInstance removes every env file and drop-in of the instance (idempotent).
func (m *StationInstances) unwireInstance(ctx context.Context, inst Instance) (bool, error) {
	restart, changed, err := m.removeStale(ctx, inst, nil)
	if err != nil {
		return false, err
	}
	if changed && m.cfg.Harness.DaemonReload != nil {
		if err := m.cfg.Harness.DaemonReload(ctx); err != nil {
			return false, coded("harness-wiring-failed", fmt.Errorf("systemd daemon-reload: %w", err))
		}
	}
	return restart, nil
}
