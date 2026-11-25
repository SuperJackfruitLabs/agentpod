// Package benchattach points a Hermes station at a remote bench and takes it back.
//
// Attach does four things, in order, and detach undoes them in reverse:
//
//  1. writes the bench certificate beside the station's bench key (`<key>-cert.pub`, which
//     OpenSSH loads on its own);
//  2. pins the bench host key as a managed line in the gateway user's known_hosts;
//  3. edits the profile's `terminal:` section to Hermes's SSH backend, with `cwd` always set to
//     the bench's working directory, and records the attachment for the agentpod-live plugin;
//  4. marks the journal attached.
//
// The journal is written first, as `attaching`, holding the profile's original terminal lines
// before anything is touched; it becomes `attached` last. A node that dies part way leaves an
// `attaching` record, and the sweep (or the next detach or attach) undoes whatever had been done
// from it, so no crash can strand a profile pointed at a bench.
//
// Neither verb restarts the gateway. Hermes reads the profile per session: an open ACP session
// keeps the backend it started with, and the next session gets the new one, so the hub opens a
// fresh session after each.
package benchattach

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchidentity"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hermes"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostfs"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
)

// Refusal codes. A refusal changes nothing.
const (
	CodeHarnessUnsupported = "harness_unsupported"
	CodeTerminalInUse      = "terminal_in_use"
	CodeAttachedElsewhere  = "attached_elsewhere"
	CodeFileMounts         = "credential_files"
	CodeInvalid            = "invalid"
	CodePluginMissing      = "plugin_missing"
)

// Detach outcomes.
const (
	StateDetached        = "detached"
	StateAbsent          = "absent"
	StateTerminalChanged = "terminal_changed"
)

// SweepGrace is how long past its certificate's expiry an attachment is left before the sweep
// takes it back, so a renewal that is merely late does not lose the session.
const SweepGrace = 5 * time.Minute

// Refusal is an attach the node declined; Message never carries a secret.
type Refusal struct{ Code, Message string }

func (r *Refusal) Error() string { return r.Code + ": " + r.Message }

func refuse(code, format string, args ...any) error {
	return &Refusal{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Attachment is one attach request, with the certificate reply SuperBench issued.
type Attachment struct {
	StationID, StationKey, AttemptID    string
	Certificate, User, Address, HostKey string
	WorkingDirectory                    string
	ValidBefore                         time.Time
}

// Manager does the work. Root is the node's config directory; KnownHosts is the gateway user's
// known_hosts; Profile resolves a station key to its Hermes profile directory.
type Manager struct {
	Root       string
	KnownHosts string
	Terminal   hermes.TerminalWriter
	Profile    func(stationKey string) (string, error)
	// PluginReady confirms the profile's agentpod-live can carry an attachment (nil error).
	// hermeslive.BenchReady when unset.
	PluginReady func(profileDir string) error
	Now         func() time.Time
}

func (m Manager) pluginReady(profileDir string) error {
	if m.PluginReady != nil {
		return m.PluginReady(profileDir)
	}
	return hermeslive.BenchReady(profileDir)
}

// mu serialises every attach, detach and sweep in this process: they share files.
var mu sync.Mutex

var (
	attemptPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	userPattern    = regexp.MustCompile(`^b-[a-f0-9]{32}$`)
	certPattern    = regexp.MustCompile(`^(ssh-ed25519|ecdsa-sha2-nistp256)-cert-v01@openssh\.com [A-Za-z0-9+/]+={0,2}( [ -~]*)?$`)
	hostKeyPattern = regexp.MustCompile(`^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,2}( [ -~]*)?$`)
)

func (m Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

func (a Attachment) validate(now time.Time) error {
	switch {
	case !benchidentity.ValidStationID(a.StationID):
		return refuse(CodeInvalid, "stationId is not a station id")
	case a.StationKey == "" || strings.ContainsAny(a.StationKey, "\r\n"):
		return refuse(CodeInvalid, "stationKey is missing")
	case !attemptPattern.MatchString(a.AttemptID):
		return refuse(CodeInvalid, "attemptId is not an attempt id")
	case !certPattern.MatchString(a.Certificate):
		return refuse(CodeInvalid, "certificate is not an OpenSSH ed25519 or ecdsa-nistp256 user certificate")
	case !userPattern.MatchString(a.User):
		return refuse(CodeInvalid, "user is not a bench principal")
	case !hostKeyPattern.MatchString(a.HostKey):
		return refuse(CodeInvalid, "host_key is not an OpenSSH public key")
	case !filepath.IsAbs(a.WorkingDirectory) || filepath.Clean(a.WorkingDirectory) != a.WorkingDirectory ||
		strings.ContainsAny(a.WorkingDirectory, "\x00\r\n"):
		return refuse(CodeInvalid, "working_directory is not a clean absolute path")
	case !a.ValidBefore.After(now):
		return refuse(CodeInvalid, "the certificate has already expired")
	}
	if _, _, _, err := hostPattern(a.Address); err != nil {
		return refuse(CodeInvalid, "%v", err)
	}
	return nil
}

// Attach points the station's profile at the bench. The same AttemptID again is a renewal: only
// the certificate (and the plugin's expiry) is rewritten.
func (m Manager) Attach(_ context.Context, a Attachment) (time.Time, error) {
	mu.Lock()
	defer mu.Unlock()
	now := m.now()
	if err := a.validate(now); err != nil {
		return time.Time{}, err
	}
	existing, ok, err := readRecord(m.Root, a.StationID)
	if err != nil {
		return time.Time{}, err
	}
	if ok && existing.State == stateAttaching {
		// A leftover from a node that died mid-attach: undo it before anything else.
		if _, err := m.detach(existing); err != nil {
			return time.Time{}, err
		}
		ok = false
	}
	if ok {
		if existing.AttemptID == a.AttemptID {
			return m.renew(existing, a)
		}
		if now.Before(existing.ValidBefore) {
			return time.Time{}, refuse(CodeAttachedElsewhere, "the station is attached for another attempt until %s",
				existing.ValidBefore.UTC().Format(time.RFC3339))
		}
		// The other attempt's certificate is dead: take it back before this one starts.
		if _, err := m.detach(existing); err != nil {
			return time.Time{}, err
		}
	}
	profileDir, err := m.Profile(a.StationKey)
	if err != nil {
		return time.Time{}, refuse(CodeInvalid, "no profile for %s: %v", a.StationKey, err)
	}
	inspection, err := m.Terminal.Inspect(profileDir)
	if err != nil {
		return time.Time{}, err
	}
	if b := inspection.Backend; b != "" && b != "local" {
		return time.Time{}, refuse(CodeTerminalInUse, "the profile's terminal backend is %q, not one this node wrote", b)
	}
	if len(inspection.CredentialMounts) > 0 {
		return time.Time{}, refuse(CodeFileMounts, "Hermes would copy credential files to the bench: %s",
			strings.Join(inspection.CredentialMounts, "; "))
	}
	if err := m.pluginReady(profileDir); err != nil {
		return time.Time{}, refuse(CodePluginMissing, "%v", err)
	}
	keyPath := benchidentity.KeyPath(m.Root, a.StationID)
	if _, err := os.Stat(keyPath); err != nil {
		return time.Time{}, refuse(CodeInvalid, "the station has no bench identity; ensure it first")
	}
	line, _ := pinLine(a.Address, a.HostKey)
	host, port, _, _ := hostPattern(a.Address)
	r := record{
		StationID: a.StationID, StationKey: a.StationKey, AttemptID: a.AttemptID, ProfileDir: profileDir,
		User: a.User, Address: a.Address, HostKey: a.HostKey, WorkingDirectory: a.WorkingDirectory,
		ValidBefore: a.ValidBefore, KeyPath: keyPath, Pinned: line, AttachedAt: now,
		Terminal: hermes.SSHTerminal{Host: host, Port: port, User: a.User, KeyPath: keyPath, Cwd: a.WorkingDirectory},
	}

	// 0. journal, attaching, with the original lines, before any edit
	prior, err := m.Terminal.Prior(profileDir)
	if err != nil {
		return time.Time{}, err
	}
	r.State, r.Prior = stateAttaching, prior
	if err := writeRecord(m.Root, r); err != nil {
		return time.Time{}, err
	}
	undo := []func(){func() { _ = removeRecord(m.Root, a.StationID) }}
	fail := func(err error) (time.Time, error) {
		for i := len(undo) - 1; i >= 0; i-- {
			undo[i]()
		}
		return time.Time{}, err
	}
	// 1. certificate
	if err := writeCert(keyPath, a.Certificate); err != nil {
		return fail(err)
	}
	undo = append(undo, func() { _ = os.Remove(benchidentity.CertPath(keyPath)) })
	// 2. host key pin
	if err := pin(m.KnownHosts, a.StationID, a.AttemptID, line); err != nil {
		return fail(fmt.Errorf("benchattach: pinning host key: %w", err))
	}
	undo = append(undo, func() { _ = unpin(m.KnownHosts, a.StationID, a.AttemptID, line) })
	// 3. terminal section, then the plugin's state
	wrote, err := m.Terminal.SetSSH(profileDir, r.Terminal)
	if err != nil {
		return fail(err)
	}
	undo = append(undo, func() { _, _ = m.Terminal.Restore(profileDir, r.Terminal, wrote) })
	if !reflect.DeepEqual(viaJSON(wrote), viaJSON(prior)) {
		// The profile changed between the journal and the edit; the journal would restore the
		// wrong lines.
		return fail(fmt.Errorf("benchattach: the profile changed while attaching; retry"))
	}
	if err := m.Terminal.WriteState(profileDir, r.state()); err != nil {
		return fail(err)
	}
	undo = append(undo, func() { _ = m.Terminal.RemoveState(profileDir) })
	// 4. journal, attached
	r.State = stateAttached
	if err := writeRecord(m.Root, r); err != nil {
		return fail(err)
	}
	log.Printf("benchattach: station %s attached to bench %s for attempt %s until %s",
		a.StationID, r.state().BenchID, a.AttemptID, a.ValidBefore.UTC().Format(time.RFC3339))
	return a.ValidBefore, nil
}

func (r record) state() hermes.BenchState {
	return hermes.BenchState{BenchID: strings.TrimPrefix(r.User, "b-"), WorkingDirectory: r.WorkingDirectory, ValidBefore: r.ValidBefore}
}

func (m Manager) renew(r record, a Attachment) (time.Time, error) {
	if r.StationKey != a.StationKey || r.User != a.User || r.Address != a.Address || r.HostKey != a.HostKey ||
		r.WorkingDirectory != a.WorkingDirectory {
		return time.Time{}, refuse(CodeInvalid, "a renewal must name the same bench, door and working directory")
	}
	if err := writeCert(r.KeyPath, a.Certificate); err != nil {
		return time.Time{}, err
	}
	r.ValidBefore = a.ValidBefore
	if err := m.Terminal.WriteState(r.ProfileDir, r.state()); err != nil {
		return time.Time{}, err
	}
	if err := writeRecord(m.Root, r); err != nil {
		return time.Time{}, err
	}
	return a.ValidBefore, nil
}

func writeCert(keyPath, cert string) error {
	if err := hostfs.AtomicWriteFile(benchidentity.CertPath(keyPath), []byte(cert+"\n"), 0o600); err != nil {
		return fmt.Errorf("benchattach: writing certificate: %w", err)
	}
	return nil
}

// Detach takes the station back from the bench. An attemptID that is not the live one is "absent":
// a late detach for an earlier attempt must never undo a newer one.
func (m Manager) Detach(_ context.Context, stationID, attemptID string) (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if !benchidentity.ValidStationID(stationID) {
		return "", refuse(CodeInvalid, "stationId is not a station id")
	}
	r, ok, err := readRecord(m.Root, stationID)
	if err != nil {
		return "", err
	}
	if ok && r.State == stateAttaching {
		// Whatever attempt it names, it is a crash's leftover; undo it.
		if _, err := m.detach(r); err != nil {
			return "", err
		}
		return StateAbsent, nil
	}
	if !ok || (attemptID != "" && r.AttemptID != attemptID) {
		return StateAbsent, nil
	}
	return m.detach(r)
}

// detach undoes an attach in reverse. The journal goes last, so a failure part way leaves a
// record to retry from.
func (m Manager) detach(r record) (string, error) {
	state := StateDetached
	changed, err := m.Terminal.Restore(r.ProfileDir, r.Terminal, r.Prior)
	if err != nil && !errors.Is(err, os.ErrNotExist) && !profileGone(r.ProfileDir) {
		return "", err
	}
	if changed && r.State != stateAttaching {
		// Someone else rewrote the terminal section since; theirs stands. (For an attach that
		// died before its edit, "changed" only means the edit never happened.)
		state = StateTerminalChanged
	}
	if err := m.Terminal.RemoveState(r.ProfileDir); err != nil && !profileGone(r.ProfileDir) {
		return "", err
	}
	if err := unpin(m.KnownHosts, r.StationID, r.AttemptID, r.Pinned); err != nil {
		return "", fmt.Errorf("benchattach: unpinning host key: %w", err)
	}
	if err := os.Remove(benchidentity.CertPath(r.KeyPath)); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("benchattach: removing certificate: %w", err)
	}
	if err := removeRecord(m.Root, r.StationID); err != nil {
		return "", err
	}
	log.Printf("benchattach: station %s detached from attempt %s (%s)", r.StationID, r.AttemptID, state)
	return state, nil
}

func profileGone(dir string) bool {
	_, err := os.Stat(dir)
	return os.IsNotExist(err)
}

// Status is the station's live attachment, if any.
func (m Manager) Status(stationID string) (attemptID string, validBefore time.Time, ok bool) {
	mu.Lock()
	defer mu.Unlock()
	if !benchidentity.ValidStationID(stationID) {
		return "", time.Time{}, false
	}
	r, found, err := readRecord(m.Root, stationID)
	if err != nil || !found || r.State == stateAttaching {
		return "", time.Time{}, false
	}
	return r.AttemptID, r.ValidBefore, true
}
