package openclawerrors

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ashramLike is the shape of ashram's ~/.openclaw/openclaw.json (2026-09-25):
// two-space indent, `meta` first, other plugins already configured, and a
// ${VAR} string the gateway expands. Everything apn does not own must survive
// an enable and a disable byte-for-byte in meaning and in key order.
const ashramLike = `{
  "meta": {
    "lastTouchedVersion": "2026.7.1-2"
  },
  "gateway": {
    "port": 18789,
    "auth": { "mode": "token", "token": "${GATEWAY_AUTH_TOKEN}" }
  },
  "plugins": {
    "entries": {
      "telegram": { "enabled": true, "config": {} },
      "opencode-go": { "enabled": true }
    }
  },
  "env": { "A": "1" }
}
`

func home(t *testing.T, config string) string {
	t.Helper()
	h := t.TempDir()
	if config != "" {
		if err := os.MkdirAll(filepath.Join(h, ".openclaw"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(h, ".openclaw", "openclaw.json"), []byte(config), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return h
}

var tested = Gate{Allowed: true, Reason: "tested"}

func topLevelKeys(t *testing.T, doc []byte) []string {
	t.Helper()
	members, err := parseObject(doc)
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(members))
	for _, m := range members {
		keys = append(keys, m.Key)
	}
	return keys
}

func TestEnableAddsOnlyWhatItOwns(t *testing.T) {
	h := home(t, ashramLike)
	plan, err := PlanEnable(h, tested)
	if err != nil {
		t.Fatal(err)
	}
	if plan.NoOp {
		t.Fatal("a fresh enable was a no-op")
	}

	var after struct {
		Meta    map[string]any `json:"meta"`
		Gateway map[string]any `json:"gateway"`
		Env     map[string]any `json:"env"`
		Plugins struct {
			Load    struct{ Paths []string }   `json:"load"`
			Entries map[string]json.RawMessage `json:"entries"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(plan.ConfigAfter, &after); err != nil {
		t.Fatalf("the planned config is not JSON: %v\n%s", err, plan.ConfigAfter)
	}
	pluginDir := filepath.Join(h, ".agentpod", "openclaw", Name)
	if len(after.Plugins.Load.Paths) != 1 || after.Plugins.Load.Paths[0] != pluginDir {
		t.Errorf("load.paths = %v, want [%s]", after.Plugins.Load.Paths, pluginDir)
	}
	var entry struct {
		Enabled bool `json:"enabled"`
		Hooks   struct {
			AllowConversationAccess bool `json:"allowConversationAccess"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(after.Plugins.Entries[Name], &entry); err != nil || !entry.Enabled || !entry.Hooks.AllowConversationAccess {
		t.Errorf("entry = %s, want enabled with hooks.allowConversationAccess (OpenClaw blocks agent_end without it)", after.Plugins.Entries[Name])
	}
	for _, other := range []string{"telegram", "opencode-go"} {
		if _, ok := after.Plugins.Entries[other]; !ok {
			t.Errorf("entry %q was lost", other)
		}
	}
	if after.Gateway["auth"].(map[string]any)["token"] != "${GATEWAY_AUTH_TOKEN}" {
		t.Error("an unexpanded ${VAR} was changed")
	}
	if got := strings.Join(topLevelKeys(t, plan.ConfigAfter), ","); got != "meta,gateway,plugins,env" {
		t.Errorf("top-level key order = %s, want meta,gateway,plugins,env", got)
	}
	if !strings.HasPrefix(string(plan.ConfigAfter), "{\n  \"meta\"") {
		t.Errorf("indentation changed:\n%s", plan.ConfigAfter)
	}
}

func TestApplyInstallsFilesAndBacksUpTheConfig(t *testing.T) {
	h := home(t, ashramLike)
	plan, err := PlanEnable(h, tested)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	if err := Apply(plan, now); err != nil {
		t.Fatal(err)
	}
	for _, name := range FileNames() {
		if _, err := os.Stat(filepath.Join(h, ".agentpod", "openclaw", Name, name)); err != nil {
			t.Errorf("plugin file %s: %v", name, err)
		}
	}
	backup := filepath.Join(h, ".openclaw", "openclaw.json.bak-agentpod-errors-20260925T120000Z")
	got, err := os.ReadFile(backup)
	if err != nil || string(got) != ashramLike {
		t.Errorf("backup missing or not the original: %v", err)
	}
	info, _ := os.Stat(filepath.Join(h, ".openclaw", "openclaw.json"))
	if info.Mode().Perm() != 0o600 {
		t.Errorf("config mode = %o, want it kept at 600 (it holds tokens)", info.Mode().Perm())
	}

	again, err := PlanEnable(h, tested)
	if err != nil {
		t.Fatal(err)
	}
	if !again.NoOp {
		t.Error("a second enable would change something")
	}
}

func TestDisableRemovesOnlyWhatItAdded(t *testing.T) {
	h := home(t, ashramLike)
	plan, _ := PlanEnable(h, tested)
	if err := Apply(plan, time.Now()); err != nil {
		t.Fatal(err)
	}
	off, err := PlanDisable(h)
	if err != nil {
		t.Fatal(err)
	}
	if err := Apply(off, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(h, ".openclaw", "openclaw.json"))
	var before, after any
	json.Unmarshal([]byte(ashramLike), &before)
	json.Unmarshal(got, &after)
	b, _ := json.Marshal(before)
	a, _ := json.Marshal(after)
	if string(a) != string(b) {
		t.Errorf("disable did not return the config to what it was:\n got %s\nwant %s", a, b)
	}
	if _, err := os.Stat(filepath.Join(h, ".agentpod", "openclaw", Name)); !os.IsNotExist(err) {
		t.Error("plugin directory still present after disable")
	}
}

func TestEnableRefusesAConfigItCannotReadSafely(t *testing.T) {
	// OpenClaw's own file is JSON, but a hand-edited one with a comment is not,
	// and rewriting it would drop what apn could not parse.
	h := home(t, "{ // hand edited\n \"gateway\": {} }\n")
	if _, err := PlanEnable(h, tested); err == nil {
		t.Fatal("planned an edit to a config it could not parse")
	}
}

func TestEnableRefusesAnUntestedOpenClaw(t *testing.T) {
	h := home(t, ashramLike)
	if _, err := PlanEnable(h, Gate{Allowed: false, Reason: "2026.1.1 is older than 2026.7.1-2"}); err == nil {
		t.Fatal("enable went ahead on an untested OpenClaw")
	}
}

func TestEnableNeedsAnOpenClawConfig(t *testing.T) {
	if _, err := PlanEnable(home(t, ""), tested); err == nil {
		t.Fatal("enable went ahead with no ~/.openclaw/openclaw.json")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"2026.7.1-2", "2026.7.1-2", 0},
		{"2026.7.1", "2026.7.1-2", -1},
		{"2026.7.1-2", "2026.9.6", -1},
		{"2026.10.1", "2026.9.6", 1},
		{"2027.1.1", "2026.12.31", 1},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCheckOpenClaw(t *testing.T) {
	min, max := TestedRange()
	if g := CheckOpenClaw("known", min, ""); !g.Allowed {
		t.Errorf("the fleet version %s was refused: %s", min, g.Reason)
	}
	if g := CheckOpenClaw("known", max, ""); !g.Allowed {
		t.Errorf("the newest tested %s was refused: %s", max, g.Reason)
	}
	if g := CheckOpenClaw("known", "2026.2.12", ""); g.Allowed {
		t.Error("2026.2.12, older than anything tested, was allowed")
	}
	if g := CheckOpenClaw("undetermined", "", "timed out"); g.Allowed {
		t.Error("an undetermined version was allowed")
	}
	if g := CheckOpenClaw("known", "OpenClaw 2026.7.1-2 (0790d9f)", ""); !g.Allowed {
		t.Errorf("the --version banner was not read: %s", g.Reason)
	}
}

func TestStatusSeesFilesConfigAndTheNodeIntake(t *testing.T) {
	h := home(t, ashramLike)
	st := Observe(h)
	if st.Installed || st.Enabled || st.IntakeListening {
		t.Errorf("fresh home: %+v", st)
	}

	plan, _ := PlanEnable(h, tested)
	if err := Apply(plan, time.Now()); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("/tmp", "oce")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	t.Setenv("AGENTPOD_TURN_ERROR_SOCKET", sock)

	st = Observe(h)
	if !st.Installed || !st.Current || !st.Enabled || !st.ConversationAccess || !st.IntakeListening {
		t.Errorf("after enable, with a node listening: %+v", st)
	}
}

// Everything outside "plugins" must come back byte-for-byte: OpenClaw and its
// operator format that file, and an inline array reflowed onto nine lines is a
// change nobody asked for. Found against ashram's real file (2026-09-25),
// where a whole-document re-encode touched 37 lines to change 8.
func TestEnableTouchesOnlyThePluginsValue(t *testing.T) {
	const cfg = `{
  "meta": { "lastTouchedVersion": "2026.7.1-2" },
  "gateway": {
    "controlUi": { "allowedOrigins": ["http://ashram:18789", "http://superchotu:18789"] }
  },
  "plugins": {
    "entries": { "telegram": { "enabled": true } }
  },
  "env": { "A": "1" }
}
`
	h := home(t, cfg)
	plan, err := PlanEnable(h, tested)
	if err != nil {
		t.Fatal(err)
	}
	after := string(plan.ConfigAfter)
	head := cfg[:strings.Index(cfg, `"plugins"`)]
	tail := cfg[strings.Index(cfg, `,
  "env"`):]
	if !strings.HasPrefix(after, head) {
		t.Errorf("bytes before plugins changed:\n%s", after)
	}
	if !strings.HasSuffix(after, tail) {
		t.Errorf("bytes after plugins changed:\n%s", after)
	}
}

func TestEnableAddsPluginsWhenThereAreNone(t *testing.T) {
	const cfg = "{\n  \"gateway\": { \"port\": 1 }\n}\n"
	h := home(t, cfg)
	plan, err := PlanEnable(h, tested)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(plan.ConfigAfter), "{\n  \"gateway\": { \"port\": 1 },\n  \"plugins\": {") {
		t.Errorf("plugins not appended after the last member:\n%s", plan.ConfigAfter)
	}
	if err := Apply(plan, time.Now()); err != nil {
		t.Fatal(err)
	}
	off, _ := PlanDisable(h)
	if string(off.ConfigAfter) != cfg {
		t.Errorf("disable did not restore the original bytes:\n got %q\nwant %q", off.ConfigAfter, cfg)
	}
}

func TestDiffShowsOnlyWhatChanged(t *testing.T) {
	before := "a\n}\nb\n}\nc\n"
	after := "a\n}\nb\n  x\n}\nc\n"
	if got := Diff(before, after); got != "  +   x\n" {
		t.Errorf("Diff = %q", got)
	}
}
