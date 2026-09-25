package hermeslive

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var installedAt = time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)

// logLine writes a line the way Hermes's logging does: local asctime, level,
// logger name, message.
func logLine(when time.Time, message string) string {
	return when.In(time.Local).Format("2006-01-02 15:04:05,000") + " INFO hermes_plugins.agentpod_live: " + message
}

func writeLog(t *testing.T, dir string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Join(append([]string{"2026-09-25 09:00:00,000 INFO gateway: unrelated line"}, lines...), "\n") + "\n"
	if err := os.WriteFile(filepath.Join(dir, "logs", "agent.log"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func installed(t *testing.T) string {
	t.Helper()
	dir := profile(t, "model: fixture\n")
	if err := Apply(ok(t)(PlanEnable(dir, allowed, false)), installedAt); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestObserveReportsALoadAndTheLastTurnAfterInstall(t *testing.T) {
	dir := installed(t)
	writeLog(t, dir,
		logLine(installedAt.Add(-time.Hour), "agentpod-live: registered; sending to id.agentpod.dev"),
		logLine(installedAt.Add(time.Minute), "agentpod-live: registered; sending to id.agentpod.dev"),
		logLine(installedAt.Add(2*time.Minute), "agentpod-live: turn t1 sent stream=40, thought=18"),
	)
	plugin, st := Observe(dir, installedAt.Add(time.Hour))
	if !st.Present || !st.Managed || !st.Current || st.Version != EmbeddedManifest().Version {
		t.Fatalf("status = %+v", st)
	}
	if st.Enabled.Value == nil || !*st.Enabled.Value {
		t.Fatalf("enabled = %+v", st.Enabled)
	}
	if st.Loaded.Value == nil || !*st.Loaded.Value {
		t.Fatalf("loaded = %+v", st.Loaded)
	}
	if st.LastTurn.Value == nil || !*st.LastTurn.Value || !strings.Contains(st.LastTurn.Reason, "stream=40") {
		t.Fatalf("last turn = %+v", st.LastTurn)
	}
	if plugin.Source.Kind != "plugin" || plugin.Scope != "profile" || plugin.Source.ArtifactDigest == nil || len(*plugin.Source.ArtifactDigest) != 64 {
		t.Fatalf("plugin = %+v", plugin)
	}
	for name, obs := range map[string]*string{"loaded": plugin.Evidence.Loaded.ObservedAt, "present": plugin.Evidence.Present.ObservedAt} {
		if obs == nil {
			t.Errorf("%s is known but has no observation time", name)
		}
	}
}

// A load from before this install says nothing about it.
func TestObserveIgnoresALoadFromBeforeTheInstall(t *testing.T) {
	dir := installed(t)
	writeLog(t, dir, logLine(installedAt.Add(-time.Minute), "agentpod-live: registered; sending to id.agentpod.dev"))
	_, st := Observe(dir, installedAt.Add(time.Hour))
	if st.Loaded.Value != nil || !strings.Contains(st.Loaded.Reason, "restart") {
		t.Fatalf("loaded = %+v", st.Loaded)
	}
}

func TestObserveReportsFailedSendsAndAnInertLoad(t *testing.T) {
	dir := installed(t)
	writeLog(t, dir,
		logLine(installedAt.Add(time.Minute), "agentpod-live: MATRIX_HOMESERVER or MATRIX_ACCESS_TOKEN unset; not registering"),
		logLine(installedAt.Add(2*time.Minute), "agentpod-live: turn t2 sent stream=3; 2 send(s) failed, first: HTTP 502"),
	)
	_, st := Observe(dir, installedAt.Add(time.Hour))
	if st.Loaded.Value == nil || *st.Loaded.Value {
		t.Fatalf("loaded = %+v", st.Loaded)
	}
	if st.LastTurn.Value == nil || *st.LastTurn.Value || !strings.Contains(st.LastTurn.Reason, "send(s) failed") {
		t.Fatalf("last turn = %+v", st.LastTurn)
	}
}

func TestObserveWithoutALogSaysSoRatherThanGuessing(t *testing.T) {
	dir := installed(t)
	_, st := Observe(dir, installedAt.Add(time.Hour))
	if st.Loaded.Value != nil || !strings.Contains(st.Loaded.Reason, "could not be read") {
		t.Fatalf("loaded = %+v", st.Loaded)
	}
}

func TestObserveAnAbsentPlugin(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	plugin, st := Observe(dir, installedAt)
	if st.Present || st.Managed || plugin.Evidence.Present.Value == nil || *plugin.Evidence.Present.Value {
		t.Fatalf("status = %+v, present = %+v", st, plugin.Evidence.Present)
	}
	if st.Enabled.Value == nil || *st.Enabled.Value {
		t.Fatalf("enabled = %+v", st.Enabled)
	}
}
