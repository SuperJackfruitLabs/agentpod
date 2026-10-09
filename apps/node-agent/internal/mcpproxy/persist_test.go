package mcpproxy

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// startAt runs a proxy for stations over a fake hub upstream, persisting its state at path.
func startAt(t *testing.T, path string, stations ...string) (*Proxy, *logSink) {
	t.Helper()
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	t.Cleanup(hub.Close)
	logs := &logSink{}
	p, err := Start(Config{
		Stations:  stations,
		HubURL:    hub.URL + "/mcp",
		Tokens:    &fakeTokens{},
		Logf:      logs.Logf,
		StatePath: path,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return p, logs
}

func statusOf(t *testing.T, s Server) int {
	t.Helper()
	return post(t, s.URL, secretOf(s), nil).StatusCode
}

// The point of persisting: a session opened before a node restart holds a URL and a secret, and
// both must still work afterwards — the port included, or the URL is dead anyway.
func TestASessionsURLAndSecretSurviveARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "mcp-proxy.json")
	p1, _ := startAt(t, path, "station_a")
	before := serverFor(t, p1, "station_a", "agentpod")
	p1.Close()

	p2, _ := startAt(t, path, "station_a")
	after := serverFor(t, p2, "station_a", "agentpod")
	if after.URL != before.URL {
		t.Fatalf("the URL changed across a restart: %s → %s", before.URL, after.URL)
	}
	if secretOf(after) != secretOf(before) {
		t.Fatal("the secret changed across a restart")
	}
	if got := statusOf(t, before); got != http.StatusOK {
		t.Fatalf("the pre-restart server entry got %d after the restart; want 200", got)
	}
}

func TestTheStateFileIsOwnerOnlyAndHoldsNoTemporaries(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "absent")
	path := filepath.Join(dir, "mcp-proxy.json")
	p, _ := startAt(t, path, "station_a", "station_b")
	if _, err := p.Rotate([]string{"station_a"}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode %v; want 0600", fi.Mode().Perm())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("state dir holds %v; want only the state file (writes are atomic renames)", names)
	}
}

func TestALooserStateFileIsTightenedOnLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp-proxy.json")
	p, _ := startAt(t, path, "station_a")
	p.Close()
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	startAt(t, path, "station_a")
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("a 0644 state file was left at %v", fi.Mode().Perm())
	}
}

func TestRotateChangesTheSecretAndTheOldOneIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp-proxy.json")
	p, logs := startAt(t, path, "station_a", "station_b")
	oldA, oldB := serverFor(t, p, "station_a", "agentpod"), serverFor(t, p, "station_b", "agentpod")

	rotated, err := p.Rotate([]string{"station_a"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(rotated, ",") != "station_a" {
		t.Fatalf("rotated %v; want [station_a]", rotated)
	}
	newA := serverFor(t, p, "station_a", "agentpod")
	if secretOf(newA) == secretOf(oldA) {
		t.Fatal("rotate kept the secret")
	}
	if got := statusOf(t, oldA); got != http.StatusUnauthorized {
		t.Fatalf("the old secret got %d after rotation; want 401", got)
	}
	if got := statusOf(t, newA); got != http.StatusOK {
		t.Fatalf("the new secret got %d; want 200", got)
	}
	if got := statusOf(t, oldB); got != http.StatusOK {
		t.Fatalf("rotating station_a broke station_b (%d)", got)
	}
	if strings.Contains(logs.String(), secretOf(oldA)) || strings.Contains(logs.String(), secretOf(newA)) {
		t.Fatal("a secret reached the log")
	}

	// And it is persisted: a restart serves the rotated secret, not the old one.
	p.Close()
	p2, _ := startAt(t, path, "station_a", "station_b")
	if secretOf(serverFor(t, p2, "station_a", "agentpod")) != secretOf(newA) {
		t.Fatal("the rotation did not survive a restart")
	}
}

func TestRotateWithNoStationsRotatesEveryServedStation(t *testing.T) {
	p, _ := startAt(t, filepath.Join(t.TempDir(), "s.json"), "station_a", "station_b")
	rotated, err := p.Rotate(nil)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(rotated)
	if strings.Join(rotated, ",") != "station_a,station_b" {
		t.Fatalf("rotated %v", rotated)
	}
}

// `apn mcp-proxy rotate` runs in another process: the running proxy must refuse the old secret
// without a restart.
func TestARotationWrittenByAnotherProcessIsHonouredWithoutARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp-proxy.json")
	p, _ := startAt(t, path, "station_a")
	old := serverFor(t, p, "station_a", "agentpod")

	if _, err := OpenStore(path).Rotate([]string{"station_a"}); err != nil {
		t.Fatal(err)
	}
	if got := statusOf(t, old); got != http.StatusUnauthorized {
		t.Fatalf("the old secret got %d after another process rotated it; want 401", got)
	}
	if got := statusOf(t, serverFor(t, p, "station_a", "agentpod")); got != http.StatusOK {
		t.Fatalf("the rotated secret got %d; want 200", got)
	}
}

func TestSetStationsAppliesWithoutARestartAndKeepsServedSecrets(t *testing.T) {
	p, _ := startAt(t, filepath.Join(t.TempDir(), "s.json"), "station_a", "station_b")
	keptA, droppedB := serverFor(t, p, "station_a", "agentpod"), serverFor(t, p, "station_b", "agentpod")

	if err := p.SetStations([]string{"station_a", "station_c"}); err != nil {
		t.Fatal(err)
	}
	if got := statusOf(t, keptA); got != http.StatusOK {
		t.Fatalf("a station still served lost its session (%d)", got)
	}
	if got := statusOf(t, droppedB); got != http.StatusUnauthorized {
		t.Fatalf("a removed station still served (%d)", got)
	}
	if p.Servers("station_b") != nil {
		t.Fatal("a removed station still has servers")
	}
	if got := statusOf(t, serverFor(t, p, "station_c", "agentpod")); got != http.StatusOK {
		t.Fatalf("an added station is not served (%d)", got)
	}
	got := p.Stations()
	sort.Strings(got)
	if strings.Join(got, ",") != "station_a,station_c" {
		t.Fatalf("Stations() = %v", got)
	}
}

func TestAPersistedPortThatIsTakenFallsBackToAFreeOne(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp-proxy.json")
	p1, _ := startAt(t, path, "station_a")
	addr := p1.Addr()
	p1.Close()
	squatter, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("could not re-take %s: %v", addr, err)
	}
	defer squatter.Close()
	p2, _ := startAt(t, path, "station_a")
	if p2.Addr() == addr {
		t.Fatal("bound a taken port")
	}
	if got := statusOf(t, serverFor(t, p2, "station_a", "agentpod")); got != http.StatusOK {
		t.Fatalf("fallback proxy got %d", got)
	}
}
