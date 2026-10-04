package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const reconcileTestBin = "/usr/local/bin/agentpod-node"

type reconcileEnv struct {
	dir    string
	unit   string
	marker string
	run    *recordingRunner
}

func newReconcileEnv(t *testing.T) *reconcileEnv {
	t.Helper()
	dir := t.TempDir()
	return &reconcileEnv{
		dir:    dir,
		unit:   filepath.Join(dir, "units", "agentpod-node.service"),
		marker: filepath.Join(dir, "state", "unit.sha256"),
		run:    newRecordingRunner(),
	}
}

func (e *reconcileEnv) opts(userScope, dry bool) ReconcileOptions {
	return ReconcileOptions{UserScope: userScope, UnitPath: e.unit, MarkerPath: e.marker, Run: e.run.run, DryRun: dry}
}

func (e *reconcileEnv) write(t *testing.T, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(e.unit), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(e.unit, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (e *reconcileEnv) read(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(e.unit)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mustRender(t *testing.T, raw, bin string) string {
	t.Helper()
	b, err := renderUnitTemplate(raw, bin)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func currentTpl(userScope bool) string {
	if userScope {
		return systemdUserUnitTemplate
	}
	return systemdSystemUnitTemplate
}

func legacyTpl(userScope bool) string {
	if userScope {
		return legacyUserUnitTemplateV1
	}
	return legacySystemUnitTemplateV1
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func TestReconcileLegacyBecomesCurrent(t *testing.T) {
	bothScopes(t, func(t *testing.T, user bool) {
		e := newReconcileEnv(t)
		e.write(t, mustRender(t, legacyTpl(user), reconcileTestBin))
		res := ReconcileUnit(e.opts(user, false))
		if res.State != "reconciled" {
			t.Fatalf("state = %v (%s)", res.State, res.Detail)
		}
		want := mustRender(t, currentTpl(user), reconcileTestBin)
		if got := e.read(t); got != want {
			t.Fatalf("content mismatch:\n%s", got)
		}
		assertCalls(t, e.run.calls, [][]string{argv(base(user), "daemon-reload")})
		m, err := os.ReadFile(e.marker)
		if err != nil || strings.TrimSpace(string(m)) != sha(want) {
			t.Fatalf("marker = %q, %v", m, err)
		}
		if user && !strings.Contains(e.read(t), "EnvironmentFile=-%h/.config/agentpod-node/otel.env") {
			t.Fatal("user unit lacks EnvironmentFile")
		}
		// second run is a no-op
		e.run.calls = nil
		res = ReconcileUnit(e.opts(user, false))
		if res.State != "current" || len(e.run.calls) != 0 {
			t.Fatalf("second run: %v %v", res, e.run.calls)
		}
		if _, err := os.Stat(e.marker); !os.IsNotExist(err) {
			t.Fatal("marker should be removed once current")
		}
		// no temp files left
		ents, _ := os.ReadDir(filepath.Dir(e.unit))
		if len(ents) != 1 {
			t.Fatalf("leftover files: %v", ents)
		}
	})
}

func TestReconcileKeepsOperatorUserGroup(t *testing.T) {
	e := newReconcileEnv(t)
	legacy := mustRender(t, legacySystemUnitTemplateV1, reconcileTestBin)
	legacy = strings.Replace(legacy, "User=root\n", "User=rakesh\nGroup=rakesh\n", 1)
	e.write(t, legacy)
	res := ReconcileUnit(e.opts(false, false))
	if res.State != "reconciled" {
		t.Fatalf("state = %v (%s)", res.State, res.Detail)
	}
	got := e.read(t)
	if !strings.Contains(got, "User=rakesh\nGroup=rakesh\n") || strings.Contains("\n"+got, "\nUser=root\n") {
		t.Fatalf("user/group not preserved:\n%s", got)
	}
	if !strings.Contains(got, "EnvironmentFile=-/etc/agentpod-node/otel.env") {
		t.Fatal("missing EnvironmentFile")
	}
}

func TestReconcileCurrentIsNoOpAndClearsMarker(t *testing.T) {
	bothScopes(t, func(t *testing.T, user bool) {
		e := newReconcileEnv(t)
		cur := mustRender(t, currentTpl(user), reconcileTestBin)
		e.write(t, cur)
		old := time.Now().Add(-time.Hour).Truncate(time.Second)
		os.Chtimes(e.unit, old, old)
		os.MkdirAll(filepath.Dir(e.marker), 0o700)
		os.WriteFile(e.marker, []byte("stale"), 0o600)
		res := ReconcileUnit(e.opts(user, false))
		if res.State != "current" {
			t.Fatalf("state = %v (%s)", res.State, res.Detail)
		}
		st, _ := os.Stat(e.unit)
		if !st.ModTime().Equal(old) || e.read(t) != cur {
			t.Fatal("unit was modified")
		}
		if len(e.run.calls) != 0 {
			t.Fatalf("calls: %v", e.run.calls)
		}
		if _, err := os.Stat(e.marker); !os.IsNotExist(err) {
			t.Fatal("marker not removed")
		}
	})
}

func TestReconcileDriftedLeavesFileAlone(t *testing.T) {
	bothScopes(t, func(t *testing.T, user bool) {
		e := newReconcileEnv(t)
		content := strings.Replace(mustRender(t, legacyTpl(user), reconcileTestBin), "Restart=always\n", "Restart=always\nEnvironment=FOO=bar\n", 1)
		e.write(t, content)
		dropin := filepath.Join(filepath.Dir(e.unit), "agentpod-node.service.d")
		os.MkdirAll(dropin, 0o755)
		os.WriteFile(filepath.Join(dropin, "x.conf"), []byte("[Service]\n"), 0o644)
		res := ReconcileUnit(e.opts(user, false))
		if res.State != "drifted" || !strings.Contains(res.Detail, "manual edits") {
			t.Fatalf("res = %+v", res)
		}
		if e.read(t) != content || len(e.run.calls) != 0 {
			t.Fatal("touched a drifted unit")
		}
		b, _ := os.ReadFile(filepath.Join(dropin, "x.conf"))
		if string(b) != "[Service]\n" {
			t.Fatal("drop-in touched")
		}
	})
}

func TestReconcileUnexpectedExecStartIsDrifted(t *testing.T) {
	e := newReconcileEnv(t)
	e.write(t, "[Service]\nExecStart=/bin/x run --flag\n")
	if res := ReconcileUnit(e.opts(true, false)); res.State != "drifted" {
		t.Fatalf("res = %+v", res)
	}
	e.write(t, "[Service]\nUser=root\n")
	if res := ReconcileUnit(e.opts(true, false)); res.State != "drifted" {
		t.Fatalf("res = %+v", res)
	}
}

func TestReconcileDryRunReportsStale(t *testing.T) {
	e := newReconcileEnv(t)
	legacy := mustRender(t, legacySystemUnitTemplateV1, reconcileTestBin)
	e.write(t, legacy)
	res := ReconcileUnit(e.opts(false, true))
	if res.State != "stale" {
		t.Fatalf("res = %+v", res)
	}
	if e.read(t) != legacy || len(e.run.calls) != 0 {
		t.Fatal("dry run wrote")
	}
	if _, err := os.Stat(e.marker); !os.IsNotExist(err) {
		t.Fatal("dry run wrote marker")
	}
}

func TestReconcileLoopGuard(t *testing.T) {
	e := newReconcileEnv(t)
	legacy := mustRender(t, legacySystemUnitTemplateV1, reconcileTestBin)
	e.write(t, legacy)
	desired := mustRender(t, systemdSystemUnitTemplate, reconcileTestBin)
	os.MkdirAll(filepath.Dir(e.marker), 0o700)
	os.WriteFile(e.marker, []byte(sha(desired)+"\n"), 0o600)
	res := ReconcileUnit(e.opts(false, false))
	if res.State != "error" || !strings.Contains(res.Detail, "did not take effect") {
		t.Fatalf("res = %+v", res)
	}
	if e.read(t) != legacy || len(e.run.calls) != 0 {
		t.Fatal("guard did not prevent rewrite")
	}
}

func TestReconcileErrors(t *testing.T) {
	e := newReconcileEnv(t)
	res := ReconcileUnit(e.opts(true, false))
	if res.State != "error" || !strings.Contains(res.Detail, e.unit) {
		t.Fatalf("missing: %+v", res)
	}
	e.write(t, mustRender(t, legacyUserUnitTemplateV1, reconcileTestBin))
	e.run.on([]string{"systemctl", "--user", "daemon-reload"}, "", errors.New("boom"))
	res = ReconcileUnit(e.opts(true, false))
	if res.State != "error" || !strings.Contains(res.Detail, "boom") {
		t.Fatalf("reload failure: %+v", res)
	}
}

func TestReconcileDaemonReloadFailureRestoresOriginalAndNextRunErrors(t *testing.T) {
	bothScopes(t, func(t *testing.T, user bool) {
		e := newReconcileEnv(t)
		legacy := mustRender(t, legacyTpl(user), reconcileTestBin)
		e.write(t, legacy)
		e.run.on(argv(base(user), "daemon-reload"), "", errors.New("boom"))
		res := ReconcileUnit(e.opts(user, false))
		if res.State != "error" || !strings.Contains(res.Detail, "boom") {
			t.Fatalf("res = %+v", res)
		}
		if e.read(t) != legacy {
			t.Fatal("original bytes not restored")
		}
		res = ReconcileUnit(e.opts(user, false))
		if res.State != "error" || !strings.Contains(res.Detail, "did not take effect") {
			t.Fatalf("next run = %+v", res)
		}
	})
}

func TestReconcileMarkerWriteFailureLeavesUnitUntouched(t *testing.T) {
	e := newReconcileEnv(t)
	legacy := mustRender(t, legacySystemUnitTemplateV1, reconcileTestBin)
	e.write(t, legacy)
	// marker's parent is a regular file, so it cannot be created
	blocker := filepath.Join(e.dir, "state")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	res := ReconcileUnit(e.opts(false, false))
	if res.State != "error" {
		t.Fatalf("res = %+v", res)
	}
	if e.read(t) != legacy || len(e.run.calls) != 0 {
		t.Fatal("unit touched despite marker failure")
	}
}

func TestReconcileDryRunLoopGuardReportsError(t *testing.T) {
	bothScopes(t, func(t *testing.T, user bool) {
		e := newReconcileEnv(t)
		legacy := mustRender(t, legacyTpl(user), reconcileTestBin)
		e.write(t, legacy)
		desired := mustRender(t, currentTpl(user), reconcileTestBin)
		os.MkdirAll(filepath.Dir(e.marker), 0o700)
		os.WriteFile(e.marker, []byte(sha(desired)+"\n"), 0o600)
		res := ReconcileUnit(e.opts(user, true))
		if res.State != "error" || !strings.Contains(res.Detail, "did not take effect") {
			t.Fatalf("res = %+v", res)
		}
		if e.read(t) != legacy || len(e.run.calls) != 0 {
			t.Fatal("dry run wrote")
		}
	})
}

func TestReconcileDryRunKeepsMarkerWhenCurrent(t *testing.T) {
	e := newReconcileEnv(t)
	e.write(t, mustRender(t, systemdSystemUnitTemplate, reconcileTestBin))
	os.MkdirAll(filepath.Dir(e.marker), 0o700)
	os.WriteFile(e.marker, []byte("x\n"), 0o600)
	res := ReconcileUnit(e.opts(false, true))
	if res.State != "current" {
		t.Fatalf("res = %+v", res)
	}
	if _, err := os.Stat(e.marker); err != nil {
		t.Fatalf("dry run removed marker: %v", err)
	}
}

func TestReconcileSymlinkedUnitIsDrifted(t *testing.T) {
	e := newReconcileEnv(t)
	target := filepath.Join(e.dir, "real.service")
	legacy := mustRender(t, legacySystemUnitTemplateV1, reconcileTestBin)
	if err := os.WriteFile(target, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Dir(e.unit), 0o755)
	if err := os.Symlink(target, e.unit); err != nil {
		t.Fatal(err)
	}
	res := ReconcileUnit(e.opts(false, false))
	if res.State != "drifted" || !strings.Contains(res.Detail, "symlink") {
		t.Fatalf("res = %+v", res)
	}
	if fi, _ := os.Lstat(e.unit); fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symlink replaced")
	}
	if b, _ := os.ReadFile(target); string(b) != legacy || len(e.run.calls) != 0 {
		t.Fatal("touched")
	}
}

func TestDeployUnitMatchesSystemTemplate(t *testing.T) {
	want := mustRender(t, systemdSystemUnitTemplate, reconcileTestBin)
	got, err := os.ReadFile(filepath.Join("..", "..", "deploy", "agentpod-node.service"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatal("deploy/agentpod-node.service drifted from the system template; regenerate it (render with BinaryPath /usr/local/bin/agentpod-node)")
	}
}
