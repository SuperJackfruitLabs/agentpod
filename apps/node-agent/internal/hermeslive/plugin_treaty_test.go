package hermeslive

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// The Hermes plugin is a second producer of AgentPod's live Matrix shapes
// (treaty phase 2, ruling 6: agentpod.matrix-activity). Its bodies are held to
// treaty's schemas here, vendored under testdata/treaty at the release
// AgentPod pins (treaty.json), because Go does not import treaty's TypeScript.
//
// The bodies are the embedded plugin's own: testdata/emit_treaty_bodies.py
// drives its LiveEmitter through a turn and prints every event it sends.

const vendoredTreaty = "testdata/treaty"

// The schemas the plugin's events are held to, by event type. Exactly the
// ones vendored: vendor what is needed, nothing more.
var pluginShapes = []string{
	"dev.agentpod.stream.delta",
	"dev.agentpod.thought.delta",
	"dev.agentpod.tool.update",
}

type emitted struct {
	Type    string         `json:"type"`
	Reader  string         `json:"reader"`
	Content map[string]any `json:"content"`
}

func pluginBodies(t *testing.T) []emitted {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("python3 is required in CI to run the plugin: %v", err)
		}
		t.Skipf("python3 not installed: %v", err)
	}
	out, err := exec.CommandContext(t.Context(), python, "-I", "-B", "testdata/emit_treaty_bodies.py", "plugin/agentpod-live/__init__.py").Output()
	if err != nil {
		var stderr []byte
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr = exitErr.Stderr
		}
		t.Fatalf("running the plugin: %v\n%s", err, stderr)
	}
	var bodies []emitted
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 0, 1<<16), 1<<20)
	for scanner.Scan() {
		var e emitted
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			t.Fatalf("plugin printed %q: %v", scanner.Text(), err)
		}
		bodies = append(bodies, e)
	}
	if len(bodies) == 0 {
		t.Fatal("the plugin sent nothing")
	}
	return bodies
}

func compileShapes(t *testing.T) map[string]*jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	ids := map[string]string{}
	for _, shape := range pluginShapes {
		path := filepath.Join(vendoredTreaty, "schemas", "matrix", shape+".json")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("vendored schema: %v", err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		id, _ := doc.(map[string]any)["$id"].(string)
		if id == "" {
			t.Fatalf("%s has no $id", path)
		}
		if err := c.AddResource(id, doc); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		ids[shape] = id
	}
	schemas := map[string]*jsonschema.Schema{}
	for shape, id := range ids {
		s, err := c.Compile(id)
		if err != nil {
			t.Fatalf("compile %s: %v", shape, err)
		}
		schemas[shape] = s
	}
	return schemas
}

func TestPluginBodiesMatchTreatysSchemas(t *testing.T) {
	schemas := compileShapes(t)
	seen := map[string]int{}
	for i, e := range pluginBodies(t) {
		s, ok := schemas[e.Type]
		if !ok {
			t.Errorf("body %d: the plugin sent %s, which has no vendored treaty schema", i, e.Type)
			continue
		}
		// Round-trip through the validator's own decoder so numbers are json.Number, as it expects.
		raw, _ := json.Marshal(e.Content)
		inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := s.Validate(inst); err != nil {
			t.Errorf("body %d (%s) is not treaty's shape: %v\n%s", i, e.Type, err, raw)
		}
		seen[e.Type]++
	}
	for _, shape := range pluginShapes {
		if seen[shape] == 0 {
			t.Errorf("the driver never made the plugin send %s", shape)
		}
	}
}

// The shapes the plan names as the Hermes producer's own: a turn id as
// session_id, made-up tc- ids, a kind only when Hermes's adapter gave one, and
// never `pending`. Each is valid treaty content; this pins that the driver
// reaches them, so the schema check above covers them.
func TestPluginSendsItsOwnShapes(t *testing.T) {
	var sessions, kinds, statuses []string
	madeUp := false
	for _, e := range pluginBodies(t) {
		sessions = append(sessions, e.Content["session_id"].(string))
		if e.Type != "dev.agentpod.tool.update" {
			continue
		}
		statuses = append(statuses, e.Content["status"].(string))
		if k, ok := e.Content["kind"].(string); ok {
			kinds = append(kinds, k)
		}
		if regexp.MustCompile(`^tc-[0-9a-f]{12}$`).MatchString(e.Content["tool_call_id"].(string)) {
			madeUp = true
		}
	}
	if !contains(sessions, "turn_1") || !contains(sessions, "ses_2") {
		t.Errorf("session ids = %v; want a turn id and a session id fallback", sessions)
	}
	if !madeUp {
		t.Error("no made-up tc- id was sent")
	}
	if len(kinds) == 0 {
		t.Error("no tool row carried a kind")
	}
	if contains(statuses, "pending") {
		t.Errorf("the plugin sent pending: %v", statuses)
	}
}

// The vendored schemas are treaty's at the release AgentPod pins, byte for
// byte: the version file must name treaty.json's pin, and when the hub's
// installed treaty is in this checkout, each copy must equal its file.
func TestVendoredTreatySchemasAreThePinnedRelease(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	manifest, err := os.ReadFile(filepath.Join(root, "treaty.json"))
	if err != nil {
		t.Fatalf("treaty.json: %v", err)
	}
	var pin struct {
		Treaty string `json:"treaty"`
	}
	if err := json.Unmarshal(manifest, &pin); err != nil {
		t.Fatal(err)
	}
	version, err := os.ReadFile(filepath.Join(vendoredTreaty, "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(version)) != pin.Treaty {
		t.Fatalf("vendored treaty is %q, treaty.json pins %q: copy the schemas again", strings.TrimSpace(string(version)), pin.Treaty)
	}

	entries, err := os.ReadDir(filepath.Join(vendoredTreaty, "schemas", "matrix"))
	if err != nil {
		t.Fatal(err)
	}
	var vendored []string
	for _, e := range entries {
		vendored = append(vendored, strings.TrimSuffix(e.Name(), ".json"))
	}
	sort.Strings(vendored)
	want := append([]string(nil), pluginShapes...)
	sort.Strings(want)
	if strings.Join(vendored, ",") != strings.Join(want, ",") {
		t.Errorf("vendored %v, the plugin's shapes are %v", vendored, want)
	}

	installed := filepath.Join(root, "apps", "hub", "node_modules", "@superjackfruitlabs", "treaty-contracts", "data")
	if _, err := os.Stat(installed); err != nil {
		t.Skipf("the hub's treaty is not installed in this checkout: %v", err)
	}
	for _, shape := range pluginShapes {
		rel := filepath.Join("schemas", "matrix", shape+".json")
		got, err := os.ReadFile(filepath.Join(vendoredTreaty, rel))
		if err != nil {
			t.Fatal(err)
		}
		upstream, err := os.ReadFile(filepath.Join(installed, rel))
		if err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
		if !bytes.Equal(got, upstream) {
			t.Errorf("%s differs from the installed treaty's; copy it again", rel)
		}
	}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
