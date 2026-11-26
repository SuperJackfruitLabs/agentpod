package benchattach

import (
	"bytes"
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchidentity"
)

// fixedKnownHosts answers one file for every bench, as ssh would for a user with no ssh_config.
func fixedKnownHosts(path string) KnownHostsResolver {
	return func(context.Context, string, string, int) (string, error) { return path, nil }
}

func TestKnownHostsFromConfig(t *testing.T) {
	for _, tc := range []struct {
		name, out, want string
	}{
		{"the first file is where ssh writes", "user b-x\nuserknownhostsfile /home/agent/.ssh/known_hosts /home/agent/.ssh/known_hosts2\n", "/home/agent/.ssh/known_hosts"},
		{"case does not matter", "UserKnownHostsFile /srv/hosts\n", "/srv/hosts"},
		{"none", "userknownhostsfile none\n", ""},
		{"the null device", "userknownhostsfile /dev/null\n", ""},
		{"a relative path", "userknownhostsfile known_hosts\n", ""},
		{"an unclean path", "userknownhostsfile /home/agent/../agent/.ssh/known_hosts\n", ""},
		{"an unexpanded home", "userknownhostsfile ~/.ssh/known_hosts\n", ""},
		{"no file at all", "user b-x\nport 2222\n", ""},
		{"a host key alias", "hostkeyalias bench\nuserknownhostsfile /home/agent/.ssh/known_hosts\n", ""},
		// ssh -G prints each path after one space and quotes none (OpenSSH 9.9 prints
		// `UserKnownHostsFile="/tmp/a b/known_hosts" /tmp/c` as `userknownhostsfile /tmp/a b/known_hosts /tmp/c`):
		// a path with a space cannot be read one way only, and its first word is a file ssh never reads.
		{"a path with a space", "userknownhostsfile /home/agent/my files/known_hosts /home/agent/.ssh/known_hosts2\n", ""},
		{"a path with a space, alone", "userknownhostsfile /home/agent/my files/known_hosts\n", ""},
		{"a double-quoted path", "userknownhostsfile \"/home/agent/my files/known_hosts\"\n", ""},
		{"a single-quoted path", "userknownhostsfile '/home/agent/.ssh/known_hosts'\n", ""},
		{"a quote inside a path", "userknownhostsfile /home/agent/.ssh/known\"hosts\n", ""},
		{"a tab between paths", "userknownhostsfile /home/agent/.ssh/known_hosts\t/srv/hosts\n", ""},
		{"two spaces between paths", "userknownhostsfile /home/agent/.ssh/known_hosts  /srv/hosts\n", ""},
		{"a later path that is not absolute", "userknownhostsfile /home/agent/.ssh/known_hosts relative\n", ""},
		{"none among others", "userknownhostsfile none /srv/hosts\n", ""},
		{"a carriage return is not a path", "userknownhostsfile /srv/hosts\r\n", "/srv/hosts"},
		{"a single clean path", "userknownhostsfile /home/agent/.ssh/known_hosts\n", "/home/agent/.ssh/known_hosts"},
	} {
		got, err := knownHostsFromConfig([]byte(tc.out))
		if tc.want == "" {
			if err == nil {
				t.Errorf("%s: answered %q, want a refusal", tc.name, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s: = %q, %v; want %q", tc.name, got, err, tc.want)
		}
	}
}

// SSHKnownHosts asks ssh with Hermes's own options, for the bench's user, host and port.
func TestSSHKnownHostsAsksSSH(t *testing.T) {
	bin := t.TempDir()
	argsFile := filepath.Join(t.TempDir(), "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argsFile + "\nprintf 'user b-x\\nuserknownhostsfile /home/agent/.ssh/known_hosts /home/agent/.ssh/known_hosts2\\n'\n"
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	got, err := SSHKnownHosts(context.Background(), benchU, "100.64.0.9", 2222)
	if err != nil || got != "/home/agent/.ssh/known_hosts" {
		t.Fatalf("SSHKnownHosts = %q, %v", got, err)
	}
	want := "-G\n-o\nBatchMode=yes\n-o\nStrictHostKeyChecking=accept-new\n-p\n2222\n" + benchU + "@100.64.0.9\n"
	if args := read(t, argsFile); args != want {
		t.Errorf("ssh was asked %q, want %q", args, want)
	}
	// An ssh that fails, or is missing, is a refusal, never a fallback path.
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\nexit 255\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := SSHKnownHosts(context.Background(), benchU, "100.64.0.9", 2222); err == nil {
		t.Errorf("a failing ssh answered %q", got)
	}
	t.Setenv("PATH", t.TempDir())
	if got, err := SSHKnownHosts(context.Background(), benchU, "100.64.0.9", 2222); err == nil {
		t.Errorf("no ssh answered %q", got)
	}
}

// An attach whose known_hosts cannot be named fails closed and writes nothing: no journal, no
// certificate, no pin, no terminal edit.
func TestAttachFailsClosedWhenKnownHostsIsUnknown(t *testing.T) {
	for name, resolver := range map[string]KnownHostsResolver{
		"ssh cannot say": func(context.Context, string, string, int) (string, error) {
			return "", errors.New("benchattach: ssh -G could not say")
		},
		"no resolver": nil,
	} {
		f := newFixture(t)
		f.m.KnownHosts = resolver
		if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err == nil {
			t.Fatalf("%s: attach succeeded", name)
		}
		assertUntouched(t, f, profileConfig)
		if _, err := os.Stat(journalPath(f.m.Root, station)); !os.IsNotExist(err) {
			t.Errorf("%s: a refused attach left a journal", name)
		}
	}
}

// A known_hosts that is a symlink (to /dev/null, say) is refused before any write.
func TestAttachRefusesKnownHostsThatIsNotARegularFile(t *testing.T) {
	f := newFixture(t)
	link := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.Symlink(os.DevNull, link); err != nil {
		t.Fatal(err)
	}
	f.m.KnownHosts = fixedKnownHosts(link)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err == nil {
		t.Fatal("attach pinned into a symlink")
	}
	assertUntouched(t, f, profileConfig)
	if target, err := os.Readlink(link); err != nil || target != os.DevNull {
		t.Errorf("the symlink was replaced: %q, %v", target, err)
	}
}

// A known_hosts (and ~/.ssh) that did not exist before the attach do not exist after the detach.
func TestDetachRemovesTheKnownHostsAttachCreated(t *testing.T) {
	f := newFixture(t)
	home := t.TempDir()
	kh := filepath.Join(home, ".ssh", "known_hosts")
	f.m.KnownHosts = fixedKnownHosts(kh)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := read(t, kh); got != "[100.64.0.9]:2222 "+hostKey+"\n# agentpod-bench st_remote1 att-1\n" {
		t.Fatalf("pin = %q", got)
	}
	if state, err := f.m.Detach(context.Background(), station, "att-1"); err != nil || state != StateDetached {
		t.Fatalf("Detach = %q, %v", state, err)
	}
	for _, p := range []string{kh, filepath.Dir(kh)} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Errorf("%s survived detach", p)
		}
	}
	// A file ssh has since added to keeps its lines; only the pin goes.
	f = newFixture(t)
	kh = filepath.Join(t.TempDir(), ".ssh", "known_hosts")
	f.m.KnownHosts = fixedKnownHosts(kh)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	learned := "forge.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n"
	mustWrite(t, kh, learned+read(t, kh))
	if _, err := f.m.Detach(context.Background(), station, "att-1"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, kh); got != learned {
		t.Errorf("known_hosts after detach = %q, want %q", got, learned)
	}
}

// Detach unpins the file the attach pinned, as journaled, whatever ssh would name now.
func TestDetachUnpinsTheJournaledKnownHosts(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "known_hosts")
	f.m.KnownHosts = fixedKnownHosts(other)
	if _, err := f.m.Detach(context.Background(), station, "att-1"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, f.knownHosts); got != otherHosts {
		t.Errorf("the pinned file was not restored: %q", got)
	}
	if _, err := os.Stat(other); !os.IsNotExist(err) {
		t.Error("detach wrote to a file the attach never pinned")
	}
	if _, err := os.Stat(benchidentity.CertPath(f.keyPath)); !os.IsNotExist(err) {
		t.Error("certificate survived")
	}
	if strings.Contains(read(t, f.knownHosts), markerPrefix) {
		t.Error("a managed line survived")
	}
}

// Attach logs which known_hosts it pinned and whether it created it, and nothing of the key.
func TestAttachLogsTheKnownHostsItPinned(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	f := newFixture(t)
	kh := filepath.Join(t.TempDir(), ".ssh", "known_hosts")
	f.m.KnownHosts = fixedKnownHosts(kh)
	if _, err := f.m.Attach(context.Background(), attachment("att-1", certA, 30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	if !strings.Contains(got, "pinned the bench host key for attempt att-1 in "+kh+" (created true)") {
		t.Errorf("log = %q, want the pinned file and that attach created it", got)
	}
	if strings.Contains(got, "AAAA") {
		t.Errorf("log carries key material: %q", got)
	}
}
