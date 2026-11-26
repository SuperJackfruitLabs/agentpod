package benchattach

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchidentity"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hermes"
	"go.yaml.in/yaml/v3"
)

const (
	station = "st_remote1"
	key     = "hermes:coder"
	benchU  = "b-0123456789abcdef0123456789abcdef"
	addr    = "100.64.0.9:2222"
	hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDdYcsw3074zsdv3Xo/Adf7y1LHHUA458+IwZo2CsvXQ"
	certA   = "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAA= agentpod bench station st_remote1"
	certB   = "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tBBBBB= agentpod bench station st_remote1"
	workDir = "/srv/superbench-data/benches/card-7"
	// An operator's profile, comments and all.
	profileConfig = "# coder's profile\nmodel:\n  default: kimi-for-coding  # pinned\n\nterminal:\n  # local until a bench\n" +
		"  backend: local\n  timeout: 180\n\nplugins:\n  enabled: [agentpod-live]\n"
	otherHosts = "# mine\ngithub.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n" +
		"|1|hashed= ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=\n"
)

var t0 = time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)

type fixture struct {
	m          Manager
	profile    string
	knownHosts string
	keyPath    string
	now        *time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root, profile, home := t.TempDir(), t.TempDir(), t.TempDir()
	mustWrite(t, filepath.Join(profile, "config.yaml"), profileConfig)
	kh := filepath.Join(home, ".ssh", "known_hosts")
	mustWrite(t, kh, otherHosts)
	// The key is ssh-keygen's to make (benchidentity's test); a placeholder stands in for it here.
	keyPath := benchidentity.KeyPath(root, station)
	mustWrite(t, keyPath, "placeholder private key")
	installPlugin(t, profile, "0.3.0")
	now := t0
	f := &fixture{profile: profile, knownHosts: kh, keyPath: keyPath, now: &now}
	f.m = Manager{Root: root, KnownHosts: fixedKnownHosts(kh), Terminal: hermes.HermesTerminal{}, Now: func() time.Time { return *f.now },
		Profile: func(k string) (string, error) {
			if k != key {
				return "", errors.New("unknown station")
			}
			return profile, nil
		}}
	return f
}

// installPlugin puts agentpod-live's manifest in the profile, as `apn hermes-live` would; the
// fixture's config already enables it.
func installPlugin(t *testing.T, profile, version string) {
	t.Helper()
	mustWrite(t, filepath.Join(profile, "plugins", "agentpod-live", "plugin.yaml"),
		"name: agentpod-live\nversion: \""+version+"\"\n")
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func attachment(attempt, cert string, validFor time.Duration) Attachment {
	return Attachment{StationID: station, StationKey: key, AttemptID: attempt, Certificate: cert, User: benchU,
		Address: addr, HostKey: hostKey, WorkingDirectory: workDir, ValidBefore: t0.Add(validFor)}
}

func code(err error) string {
	var r *Refusal
	if errors.As(err, &r) {
		return r.Code
	}
	return ""
}

func (f *fixture) config(t *testing.T) string {
	return read(t, filepath.Join(f.profile, "config.yaml"))
}

func TestAttachWritesCertPinAndTerminal(t *testing.T) {
	f := newFixture(t)
	until, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute))
	if err != nil || !until.Equal(t0.Add(30*time.Minute)) {
		t.Fatalf("Attach = %v, %v", until, err)
	}
	if got := read(t, benchidentity.CertPath(f.keyPath)); got != certA+"\n" {
		t.Errorf("certificate = %q", got)
	}
	var doc struct{ Terminal map[string]any }
	if err := yaml.Unmarshal([]byte(f.config(t)), &doc); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"backend": "ssh", "ssh_host": "100.64.0.9", "ssh_port": 2222, "ssh_user": benchU,
		"ssh_key": f.keyPath, "cwd": workDir, "timeout": 180}
	if len(doc.Terminal) != len(want) {
		t.Errorf("terminal = %v", doc.Terminal)
	}
	for k, v := range want {
		if doc.Terminal[k] != v {
			t.Errorf("terminal.%s = %#v, want %#v", k, doc.Terminal[k], v)
		}
	}
	kh := read(t, f.knownHosts)
	if n := strings.Count(kh, markerPrefix); n != 1 {
		t.Fatalf("%d managed lines:\n%s", n, kh)
	}
	if !strings.HasSuffix(kh, "[100.64.0.9]:2222 "+hostKey+"\n# agentpod-bench st_remote1 att-1\n") {
		t.Errorf("pin is not the managed pair:\n%s", kh)
	}
	state := read(t, filepath.Join(f.profile, hermes.BenchStateFile))
	if !strings.Contains(state, `"bench_id":"0123456789abcdef0123456789abcdef"`) || !strings.Contains(state, workDir) {
		t.Errorf("plugin state = %s", state)
	}
	if attempt, vb, ok := f.m.Status(station); !ok || attempt != "att-1" || !vb.Equal(until) {
		t.Errorf("Status = %q %v %v", attempt, vb, ok)
	}
	info, _ := os.Stat(journalPath(f.m.Root, station))
	if info == nil || info.Mode().Perm() != 0o600 {
		t.Errorf("journal mode: %v", info)
	}
}

func TestRenewRewritesOnlyCertificate(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	config, kh := f.config(t), read(t, f.knownHosts)
	*f.now = t0.Add(20 * time.Minute)
	until, err := f.m.Attach(context.Background(), attachment("att-1", certB, 50*time.Minute))
	if err != nil || !until.Equal(t0.Add(50*time.Minute)) {
		t.Fatalf("renew = %v, %v", until, err)
	}
	if got := read(t, benchidentity.CertPath(f.keyPath)); got != certB+"\n" {
		t.Errorf("certificate not renewed: %q", got)
	}
	if f.config(t) != config || read(t, f.knownHosts) != kh {
		t.Error("a renewal touched the profile or known_hosts")
	}
	if _, vb, _ := f.m.Status(station); !vb.Equal(until) {
		t.Errorf("journal not renewed: %v", vb)
	}
	moved := attachment("att-1", certB, 50*time.Minute)
	moved.Address = "100.64.0.10:2222"
	if _, err := f.m.Attach(context.Background(), moved); code(err) != CodeInvalid {
		t.Errorf("a renewal to another door = %v", err)
	}
}

func TestAttachRefusesTerminalInUse(t *testing.T) {
	f := newFixture(t)
	docker := strings.Replace(profileConfig, "backend: local", "backend: docker", 1)
	mustWrite(t, filepath.Join(f.profile, "config.yaml"), docker)
	_, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute))
	if code(err) != CodeTerminalInUse {
		t.Fatalf("Attach = %v", err)
	}
	assertUntouched(t, f, docker)
}

func TestAttachRefusesCredentialFiles(t *testing.T) {
	f := newFixture(t)
	withCreds := strings.Replace(profileConfig, "  timeout: 180\n", "  timeout: 180\n  credential_files: [.env]\n", 1)
	mustWrite(t, filepath.Join(f.profile, "config.yaml"), withCreds)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); code(err) != CodeFileMounts {
		t.Fatalf("Attach = %v", err)
	}
	assertUntouched(t, f, withCreds)

	f = newFixture(t)
	mustWrite(t, filepath.Join(f.profile, "skills", "kube", "SKILL.md"), "---\nname: kube\nrequired_credential_files: [kube.conf]\n---\n")
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); code(err) != CodeFileMounts {
		t.Fatalf("Attach with a credential skill = %v", err)
	}
	assertUntouched(t, f, profileConfig)
}

func assertUntouched(t *testing.T, f *fixture, config string) {
	t.Helper()
	if f.config(t) != config {
		t.Error("a refused attach changed config.yaml")
	}
	if read(t, f.knownHosts) != otherHosts {
		t.Error("a refused attach changed known_hosts")
	}
	if _, err := os.Stat(benchidentity.CertPath(f.keyPath)); !os.IsNotExist(err) {
		t.Error("a refused attach wrote a certificate")
	}
	if _, _, ok := f.m.Status(station); ok {
		t.Error("a refused attach journaled")
	}
}

func TestAttachRefusesSecondAttempt(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	config := f.config(t)
	if _, err := f.m.Attach(context.Background(), attachment("att-2", certB, 30*time.Minute)); code(err) != CodeAttachedElsewhere {
		t.Fatalf("second attempt = %v", err)
	}
	if f.config(t) != config || read(t, benchidentity.CertPath(f.keyPath)) != certA+"\n" {
		t.Error("a refused second attempt changed the first's attachment")
	}
	// Once the first certificate is dead, a new attempt takes over.
	*f.now = t0.Add(31 * time.Minute)
	if _, err := f.m.Attach(context.Background(), attachment("att-2", certB, 60*time.Minute)); err != nil {
		t.Fatalf("attempt after expiry = %v", err)
	}
	if n := strings.Count(read(t, f.knownHosts), markerPrefix); n != 1 {
		t.Errorf("%d managed lines after takeover", n)
	}
}

func TestDetachRestoresExactly(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	state, err := f.m.Detach(context.Background(), station, "att-1")
	if err != nil || state != StateDetached {
		t.Fatalf("Detach = %q, %v", state, err)
	}
	if got := f.config(t); got != profileConfig {
		t.Fatalf("config.yaml not restored byte for byte:\nwant %q\ngot  %q", profileConfig, got)
	}
	if got := read(t, f.knownHosts); got != otherHosts {
		t.Fatalf("known_hosts not restored:\n%q", got)
	}
	for _, p := range []string{benchidentity.CertPath(f.keyPath), filepath.Join(f.profile, hermes.BenchStateFile), journalPath(f.m.Root, station)} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s survived detach", p)
		}
	}
	if _, err := os.Stat(f.keyPath); err != nil {
		t.Error("detach removed the station's key")
	}
}

func TestDetachLeavesOperatorEditAlone(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(f.config(t), "backend: ssh", "backend: docker", 1)
	mustWrite(t, filepath.Join(f.profile, "config.yaml"), edited)
	state, err := f.m.Detach(context.Background(), station, "att-1")
	if err != nil || state != StateTerminalChanged {
		t.Fatalf("Detach = %q, %v", state, err)
	}
	if f.config(t) != edited {
		t.Error("detach rewrote an operator's terminal section")
	}
	if read(t, f.knownHosts) != otherHosts {
		t.Error("detach left the pin behind")
	}

	// An edit outside the terminal section survives a detach that restores ours.
	f = newFixture(t)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(f.profile, "config.yaml"), strings.Replace(f.config(t), "kimi-for-coding", "kimi-k3", 1))
	if state, err := f.m.Detach(context.Background(), station, "att-1"); err != nil || state != StateDetached {
		t.Fatalf("Detach = %q, %v", state, err)
	}
	if want := strings.Replace(profileConfig, "kimi-for-coding", "kimi-k3", 1); f.config(t) != want {
		t.Errorf("config = %q", f.config(t))
	}
}

func TestDetachAbsentIsIdempotent(t *testing.T) {
	f := newFixture(t)
	if state, err := f.m.Detach(context.Background(), station, "att-1"); err != nil || state != StateAbsent {
		t.Fatalf("Detach with nothing attached = %q, %v", state, err)
	}
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if state, _ := f.m.Detach(context.Background(), station, "att-0"); state != StateAbsent {
		t.Fatalf("a detach for another attempt = %q", state)
	}
	if _, _, ok := f.m.Status(station); !ok {
		t.Fatal("a detach for another attempt detached this one")
	}
	for i, want := range []string{StateDetached, StateAbsent} {
		if state, err := f.m.Detach(context.Background(), station, "att-1"); err != nil || state != want {
			t.Fatalf("detach %d = %q, %v", i, state, err)
		}
	}
	if f.config(t) != profileConfig {
		t.Error("a repeated detach changed the profile")
	}
}

func TestSweepRestoresAfterExpiry(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	f.m.Sweep(t0.Add(30*time.Minute + SweepGrace))
	if _, _, ok := f.m.Status(station); !ok {
		t.Fatal("the sweep took an attachment back within its grace")
	}
	f.m.Sweep(t0.Add(30*time.Minute + SweepGrace + time.Second))
	if _, _, ok := f.m.Status(station); ok {
		t.Fatal("the sweep left an expired attachment")
	}
	if f.config(t) != profileConfig || read(t, f.knownHosts) != otherHosts {
		t.Error("the sweep did not restore exactly")
	}
}

func TestKnownHostsKeepsOtherLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "known_hosts")
	line := "[100.64.0.9]:2222 " + hostKey
	// Someone else's pin of the same door, and another station's managed pair, both stay.
	other := otherHosts + line + "\n" + "[100.64.0.7]:2222 " + hostKey + "\n# agentpod-bench st_other att-9\n"
	mustWrite(t, path, other)
	if err := pin(path, station, "att-1", line); err != nil {
		t.Fatal(err)
	}
	if err := unpin(path, station, "att-1", line); err != nil {
		t.Fatal(err)
	}
	if got := read(t, path); got != other {
		t.Fatalf("other lines changed:\nwant %q\ngot  %q", other, got)
	}
	// An absent file is created 0600 and removed back to empty.
	fresh := filepath.Join(dir, "new", "known_hosts")
	if err := pin(fresh, station, "att-1", line); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(fresh); info.Mode().Perm() != 0o600 {
		t.Errorf("created known_hosts mode %v", info.Mode())
	}
	if err := unpin(fresh, station, "att-1", line); err != nil || read(t, fresh) != "" {
		t.Errorf("unpin of a fresh file: %v %q", err, read(t, fresh))
	}
}

func TestAttachRefusesInvalid(t *testing.T) {
	f := newFixture(t)
	bad := []func(*Attachment){
		func(a *Attachment) { a.StationID = "../x" },
		func(a *Attachment) { a.AttemptID = "a b" },
		func(a *Attachment) { a.Certificate = "ssh-ed25519 AAAA" },
		func(a *Attachment) { a.User = "root" },
		func(a *Attachment) { a.Address = "100.64.0.9" },
		func(a *Attachment) { a.HostKey = hostKey + "\n@cert-authority * ssh-ed25519 AAAA" },
		func(a *Attachment) { a.WorkingDirectory = "relative" },
		func(a *Attachment) { a.ValidBefore = t0 },
	}
	for i, mutate := range bad {
		a := attachment("att-1", certA, 30*time.Minute)
		mutate(&a)
		if _, err := f.m.Attach(context.Background(), a); code(err) != CodeInvalid {
			t.Errorf("case %d: %v", i, err)
		}
	}
	assertUntouched(t, f, profileConfig)
}

func TestAttachRefusesPluginMissing(t *testing.T) {
	cases := map[string]func(*fixture){
		"not installed": func(f *fixture) { _ = os.RemoveAll(filepath.Join(f.profile, "plugins")) },
		"too old":       func(f *fixture) { installPlugin(t, f.profile, "0.2.0") },
		"not enabled": func(f *fixture) {
			mustWrite(t, filepath.Join(f.profile, "config.yaml"), strings.Replace(profileConfig, "[agentpod-live]", "[]", 1))
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			mutate(f)
			config := f.config(t)
			if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); code(err) != CodePluginMissing {
				t.Fatalf("Attach = %v", err)
			}
			assertUntouched(t, f, config)
		})
	}
}

// crashing stands in for a node that dies after the terminal edit, before the plugin's state
// and the journal's "attached": it panics, so no rollback runs.
type crashing struct{ hermes.HermesTerminal }

func (crashing) WriteState(string, hermes.BenchState) error { panic("node died") }

func TestSweepRecoversACrashAfterTheTerminalEdit(t *testing.T) {
	for _, recover_ := range []string{"sweep", "detach", "attach"} {
		t.Run(recover_, func(t *testing.T) {
			f := newFixture(t)
			crashed := f.m
			crashed.Terminal = crashing{}
			func() {
				defer func() { _ = recover() }()
				_, _ = crashed.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute))
				t.Fatal("the crash did not happen")
			}()
			if !strings.Contains(f.config(t), "backend: ssh") || !strings.Contains(read(t, f.knownHosts), markerPrefix) {
				t.Fatal("the simulated crash came before the terminal edit")
			}
			if _, _, ok := f.m.Status(station); ok {
				t.Fatal("a half-done attach reports as attached")
			}
			switch recover_ {
			case "sweep":
				f.m.Sweep(t0) // long before any expiry
			case "detach":
				if state, err := f.m.Detach(context.Background(), station, "att-other"); err != nil || state != StateAbsent {
					t.Fatalf("Detach = %q, %v", state, err)
				}
			case "attach":
				if _, err := f.m.Attach(context.Background(), attachment("att-2", certB, 30*time.Minute)); err != nil {
					t.Fatalf("Attach after the crash = %v", err)
				}
				if _, err := f.m.Detach(context.Background(), station, "att-2"); err != nil {
					t.Fatal(err)
				}
			}
			if got := f.config(t); got != profileConfig {
				t.Fatalf("config.yaml not restored byte for byte:\nwant %q\ngot  %q", profileConfig, got)
			}
			if got := read(t, f.knownHosts); got != otherHosts {
				t.Fatalf("known_hosts not restored: %q", got)
			}
			for _, p := range []string{benchidentity.CertPath(f.keyPath), journalPath(f.m.Root, station)} {
				if _, err := os.Stat(p); !os.IsNotExist(err) {
					t.Errorf("%s survived the recovery", p)
				}
			}
		})
	}
}

func TestSweepRecoversACrashBeforeAnyEdit(t *testing.T) {
	f := newFixture(t)
	prior, err := hermes.HermesTerminal{}.Prior(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	// The journal is the first write: a crash right after it leaves only the record. A record from
	// before the journal named its known_hosts asks the resolver instead.
	for _, journaled := range []string{f.knownHosts, ""} {
		r := record{StationID: station, StationKey: key, AttemptID: "att-1", ProfileDir: f.profile, State: stateAttaching,
			User: benchU, Address: addr, KeyPath: f.keyPath, Pinned: "[100.64.0.9]:2222 " + hostKey, Prior: prior,
			KnownHosts: journaled,
			Terminal:   hermes.SSHTerminal{Host: "100.64.0.9", Port: 2222, User: benchU, KeyPath: f.keyPath, Cwd: workDir}}
		if err := writeRecord(f.m.Root, r); err != nil {
			t.Fatal(err)
		}
		f.m.Sweep(t0)
		if f.config(t) != profileConfig || read(t, f.knownHosts) != otherHosts {
			t.Fatal("recovering an attach that never edited changed the profile")
		}
		if _, err := os.Stat(journalPath(f.m.Root, station)); !os.IsNotExist(err) {
			t.Fatalf("the leftover record (known_hosts %q) survived", journaled)
		}
	}
}

// The address host and the host key go into known_hosts. Anything that could widen the pin or
// add a line is refused before a single file is written.
func TestAttachRefusesKnownHostsInjection(t *testing.T) {
	addresses := []string{
		"x\n@cert-authority * " + hostKey + " c:2222",
		"evil,*:22",
		"x,*:22",
		"*:2222",
		"bench?.example:2222",
		"!bench.example:2222",
		"a@b:2222",
		"a b:2222",
		"a\tb:2222",
		"bench\x00.example:2222",
		"-bench.example:2222",
		"bench-.example:2222",
		"bench..example:2222",
		strings.Repeat("a.", 127) + "aa:2222", // 256 characters
		"[fe80::1%eth0]:2222",                 // zone
		"[100.64.0.9]:2222",                   // IPv4 in brackets
		"[bench.example]:2222",
	}
	for _, address := range addresses {
		f := newFixture(t)
		a := attachment("att-1", certA, 30*time.Minute)
		a.Address = address
		if _, err := f.m.Attach(context.Background(), a); code(err) != CodeInvalid {
			t.Errorf("address %q: %v", address, err)
		}
		assertUntouched(t, f, profileConfig)
	}
	for _, hk := range []string{
		hostKey + "\n@cert-authority * " + hostKey,
		hostKey + "\r",
		hostKey + " comment\x7f",
		hostKey + " comment\x1b[0m",
	} {
		f := newFixture(t)
		a := attachment("att-1", certA, 30*time.Minute)
		a.HostKey = hk
		if _, err := f.m.Attach(context.Background(), a); code(err) != CodeInvalid {
			t.Errorf("host key %q: %v", hk, err)
		}
		assertUntouched(t, f, profileConfig)
	}
}

func TestAttachAcceptsIPAndHostnameDoors(t *testing.T) {
	for address, pattern := range map[string]string{
		"100.64.0.9:2222":       "[100.64.0.9]:2222",
		"[fd00::9]:2222":        "[fd00::9]:2222",
		"bench-1.example:2222":  "[bench-1.example]:2222",
		"bench.example:22":      "bench.example",
		"bench.example.com:443": "[bench.example.com]:443",
	} {
		f := newFixture(t)
		a := attachment("att-1", certA, 30*time.Minute)
		a.Address = address
		if _, err := f.m.Attach(context.Background(), a); err != nil {
			t.Fatalf("%s: %v", address, err)
		}
		if kh := read(t, f.knownHosts); !strings.Contains(kh, "\n"+pattern+" "+hostKey+"\n# agentpod-bench ") {
			t.Errorf("%s pinned as:\n%s", address, kh)
		}
		if _, err := f.m.Detach(context.Background(), station, "att-1"); err != nil || read(t, f.knownHosts) != otherHosts {
			t.Errorf("%s: detach left %q (%v)", address, read(t, f.knownHosts), err)
		}
	}
}
