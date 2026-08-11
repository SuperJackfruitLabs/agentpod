package posture

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// ─── grading ─────────────────────────────────────────────────────────────────

func TestGradeReflectsWorstFailure(t *testing.T) {
	cases := []struct {
		name     string
		findings []Finding
		want     string
	}{
		{"nothing found", nil, "A"},
		{"only passes", []Finding{{Status: StatusPass, Severity: SeverityCritical}}, "A"},
		{"an info failure", []Finding{{Status: StatusFail, Severity: SeverityInfo}}, "B"},
		{"a warning", []Finding{{Status: StatusFail, Severity: SeverityWarning}}, "C"},
		{"a critical", []Finding{{Status: StatusFail, Severity: SeverityCritical}}, "F"},
		{"worst wins", []Finding{
			{Status: StatusFail, Severity: SeverityWarning},
			{Status: StatusFail, Severity: SeverityCritical},
		}, "F"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Grade(c.findings); got != c.want {
				t.Errorf("Grade() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestUnknownNeverCountsAsAPassOrAFailure(t *testing.T) {
	// A check that could not determine an answer must not improve the grade
	// (that would reward ignorance) and must not worsen it (that would cry
	// wolf). It is reported and excluded from scoring.
	f := []Finding{{Status: StatusUnknown, Severity: SeverityCritical}}
	if got := Grade(f); got != "A" {
		t.Errorf("unknown-only report graded %q, want A", got)
	}
}

func TestExitCodeIsUsableInCron(t *testing.T) {
	for grade, want := range map[string]int{"A": 0, "B": 0, "C": 1, "F": 2} {
		if got := ExitCode(grade); got != want {
			t.Errorf("ExitCode(%q) = %d, want %d", grade, got, want)
		}
	}
}

func TestSortPutsFailuresFirstWorstFirst(t *testing.T) {
	in := []Finding{
		{Check: "b", Status: StatusPass, Severity: SeverityInfo},
		{Check: "c", Status: StatusFail, Severity: SeverityWarning},
		{Check: "a", Status: StatusFail, Severity: SeverityCritical},
	}
	Sort(in)
	if in[0].Check != "a" || in[1].Check != "c" || in[2].Check != "b" {
		t.Errorf("order = %s,%s,%s; want a,c,b", in[0].Check, in[1].Check, in[2].Check)
	}
}

// ─── credentials ─────────────────────────────────────────────────────────────

func writeMode(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"token":"redacted"}`), mode); err != nil {
		t.Fatal(err)
	}
	// WriteFile respects umask, so set the mode explicitly.
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func TestWorldReadableCredentialsAreCritical(t *testing.T) {
	// Forces the exposure verdict rather than relying on the filesystem: macOS
	// gives each user a private TMPDIR at 0700, so nothing a test writes there
	// is reachable by another user and this branch would be unreachable on a
	// Mac. The walk that produces the verdict is tested in reach_test.go.
	defer forceExposure(t, Exposure{World: true, Group: true})()

	home := t.TempDir()
	writeMode(t, filepath.Join(home, ".codex/auth.json"), 0o644)

	findings := CheckCredentialFiles(home, []string{"codex"})

	var fail *Finding
	for i := range findings {
		if findings[i].Status == StatusFail {
			fail = &findings[i]
		}
	}
	if fail == nil {
		t.Fatalf("a 0644 credential file produced no failure: %+v", findings)
	}
	if fail.Severity != SeverityCritical {
		t.Errorf("severity = %q, want critical", fail.Severity)
	}
	if fail.Remedy == "" {
		t.Error("a finding without a remedy is a complaint, not a check")
	}
}

func TestOwnerOnlyCredentialsPass(t *testing.T) {
	home := t.TempDir()
	writeMode(t, filepath.Join(home, ".codex/auth.json"), 0o600)

	findings := CheckCredentialFiles(home, []string{"codex"})
	for _, f := range findings {
		if f.Status == StatusFail {
			t.Errorf("0600 credential file flagged: %+v", f)
		}
	}
	if Grade(findings) != "A" {
		t.Errorf("grade = %q, want A", Grade(findings))
	}
}

func TestGroupReadableIsAlsoFlagged(t *testing.T) {
	// 0640 leaks to the group, which on a shared box is still "other people".
	defer forceExposure(t, Exposure{Group: true})()

	home := t.TempDir()
	writeMode(t, filepath.Join(home, ".codex/auth.json"), 0o640)

	if Grade(CheckCredentialFiles(home, []string{"codex"})) != "F" {
		t.Error("a group-readable credential file should fail the scan")
	}
}

func TestMissingCredentialFileIsNotAFinding(t *testing.T) {
	// Not every harness stores every file. Absence must not be reported as a
	// problem, or the scan is noise on a healthy machine.
	findings := CheckCredentialFiles(t.TempDir(), []string{"codex", "hermes", "openclaw"})
	for _, f := range findings {
		if f.Status == StatusFail {
			t.Errorf("absent file reported as a failure: %+v", f)
		}
	}
}

func TestUnknownHarnessIsSkippedNotGuessed(t *testing.T) {
	if got := CheckCredentialFiles(t.TempDir(), []string{"not-a-harness"}); len(got) != 0 {
		t.Errorf("unknown harness produced findings: %+v", got)
	}
}

// ─── listeners ───────────────────────────────────────────────────────────────

const lsofSample = `COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
openclaw  12345 rakesh   23u  IPv4 0x1234567890abcdef      0t0  TCP *:3000 (LISTEN)
hermes    23456 rakesh   24u  IPv4 0xabcdefabcdefabcd      0t0  TCP 127.0.0.1:8080 (LISTEN)
opencode  34567 rakesh   25u  IPv6 0xfedcbafedcbafedc      0t0  TCP [::]:9000 (LISTEN)
codex     45678 rakesh   26u  IPv6 0x1111111111111111      0t0  TCP [::1]:9100 (LISTEN)
postgres  56789 rakesh   27u  IPv4 0x2222222222222222      0t0  TCP *:5432 (LISTEN)
Dropbox   67890 rakesh   28u  IPv4 0x3333333333333333      0t0  TCP 127.0.0.1:17600 (LISTEN)
`

func TestParseLsofReadsListeningSockets(t *testing.T) {
	got := ParseLsof(lsofSample)
	if len(got) != 6 {
		t.Fatalf("parsed %d listeners, want 6: %+v", len(got), got)
	}
	if got[0].Command != "openclaw" || got[0].Addr != "*:3000" {
		t.Errorf("first listener = %+v", got[0])
	}
}

func TestPublicBindDetection(t *testing.T) {
	cases := map[string]bool{
		"*:3000":          true,
		"0.0.0.0:3000":    true,
		"[::]:9000":       true,
		"127.0.0.1:8080":  false,
		"[::1]:9100":      false,
		"192.168.1.5:443": false, // a specific interface is not "everywhere"
	}
	for addr, want := range cases {
		if got := (Listener{Addr: addr}).IsPublic(); got != want {
			t.Errorf("IsPublic(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestOnlyHarnessListenersAreFlagged(t *testing.T) {
	findings := EvaluateListeners(ParseLsof(lsofSample))

	var failed []string
	for _, f := range findings {
		if f.Status == StatusFail {
			failed = append(failed, f.Harness)
		}
	}
	// openclaw on *:3000 and opencode on [::]:9000 are exposed.
	// hermes and codex are on loopback. postgres and Dropbox are not agents and
	// must not appear at all — this is an agent check, not a port audit.
	if len(failed) != 2 {
		t.Fatalf("failures = %v, want openclaw and opencode", failed)
	}
	for _, f := range findings {
		if f.Harness == "" && f.Status == StatusFail {
			t.Errorf("a non-harness process was flagged: %+v", f)
		}
	}
	if Grade(findings) != "F" {
		t.Errorf("grade = %q, want F — an exposed agent is critical", Grade(findings))
	}
}

func TestNoHarnessListenersPasses(t *testing.T) {
	only := `COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
postgres  56789 rakesh   27u  IPv4 0x2222222222222222      0t0  TCP *:5432 (LISTEN)
`
	findings := EvaluateListeners(ParseLsof(only))
	if Grade(findings) != "A" {
		t.Errorf("grade = %q, want A — a non-agent listener is not our business", Grade(findings))
	}
}

// ─── corrected paths ────────────────────────────────────────────────────────

// The bug this pins: the shipped map named files that do not exist for hermes
// and openclaw, so `apn scan` graded machines A having opened nothing. Verified
// against molt-bot and superchotu on 2026-08-11.
func TestCredentialPathsMatchRealHarnessLayouts(t *testing.T) {
	want := map[string][]string{
		"hermes":   {".hermes/config.yaml", ".hermes/auth.json", ".hermes/.env"},
		"openclaw": {".openclaw/openclaw.json", ".openclaw/.env", ".openclaw/gateway.systemd.env", ".openclaw/credentials/*.json"},
	}
	for harness, paths := range want {
		got := CredentialPaths[harness]
		for _, p := range paths {
			if !slices.Contains(got, p) {
				t.Errorf("%s: missing %q from %v", harness, p, got)
			}
		}
	}
}

func TestCredentialPathsDropTheFilesThatNeverExisted(t *testing.T) {
	// Keeping a path that matches nothing is not harmless: it is what made the
	// scan look thorough while checking nothing.
	gone := map[string][]string{
		"hermes":   {".hermes/config.json", ".hermes/credentials.json"},
		"openclaw": {".openclaw/config.json", ".openclaw/credentials.json", ".openclaw/gateway.json"},
	}
	for harness, paths := range gone {
		for _, p := range paths {
			if slices.Contains(CredentialPaths[harness], p) {
				t.Errorf("%s: %q does not exist on any real machine and must be removed", harness, p)
			}
		}
	}
}

func TestCredentialGlobsExpand(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".openclaw", "credentials")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"telegram-pairing.json", "gateway-pairing.json", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	got := expandCredentialPaths(home, ".openclaw/credentials/*.json")
	if len(got) != 2 {
		t.Fatalf("expanded to %d paths, want 2 (json only): %v", len(got), got)
	}
}

func TestCredentialGlobMatchingNothingIsSilent(t *testing.T) {
	// Same rule as an absent literal: absence is not a finding.
	got := expandCredentialPaths(t.TempDir(), ".openclaw/credentials/*.json")
	if len(got) != 0 {
		t.Errorf("want no paths, got %v", got)
	}
}

func TestUnreachableFileIsNotReportedAsExposed(t *testing.T) {
	// The molt-bot case end-to-end: a 644 credential file under a 700 ancestor
	// is not exposed and must not be a finding. Without this, correcting the
	// paths turns a secured box into 15 false criticals.
	home := t.TempDir()
	hermes := filepath.Join(home, ".hermes")
	if err := os.MkdirAll(hermes, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(hermes, "auth.json")
	if err := os.WriteFile(p, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(hermes, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(hermes, 0o755) })

	for _, f := range CheckCredentialFiles(home, []string{"hermes"}) {
		if f.Status == StatusFail {
			t.Errorf("unreachable file reported as exposed: %+v", f)
		}
	}
}

// forceExposure makes the credential checks see a fixed verdict, returning a
// restore func. See the comment on exposureOf for why this is necessary.
func forceExposure(t *testing.T, e Exposure) func() {
	t.Helper()
	prev := exposureOf
	exposureOf = func(string) (Exposure, error) { return e, nil }
	return func() { exposureOf = prev }
}
