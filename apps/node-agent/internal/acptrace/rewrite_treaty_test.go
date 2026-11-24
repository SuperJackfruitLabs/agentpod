package acptrace

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/telemetry/telemetrytest"
)

// Treaty's telemetry conventions (schemas/telemetry/suite.v1.json, the
// superwitness.telemetry crossing), vendored at the release treaty.json pins.
// The rewrite is the node's half of their `acp-meta-traceparent` propagation:
// what it hands the harness in `_meta` must be a carrier the convention
// describes, on the methods it names.
var vendoredConventions = filepath.Join("testdata", "treaty", "schemas", "telemetry", "suite.v1.json")

const propagation = "acp-meta-traceparent"

type propagationDef struct {
	Carrier string   `json:"carrier"`
	Methods []string `json:"methods"`
	Fields  map[string]struct {
		Required bool            `json:"required"`
		Schema   json.RawMessage `json:"schema"`
	} `json:"fields"`
}

type fieldSchema struct {
	required bool
	schema   *jsonschema.Schema
}

func loadPropagation(t *testing.T) (propagationDef, map[string]fieldSchema) {
	t.Helper()
	raw, err := os.ReadFile(vendoredConventions)
	if err != nil {
		t.Fatalf("vendored conventions: %v", err)
	}
	var doc struct {
		Propagation map[string]propagationDef `json:"propagation"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	def, ok := doc.Propagation[propagation]
	if !ok {
		t.Fatalf("the conventions have no %s", propagation)
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	fields := map[string]fieldSchema{}
	for name, f := range def.Fields {
		s, err := jsonschema.UnmarshalJSON(bytes.NewReader(f.Schema))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		id := "urn:treaty:suite.v1:" + propagation + ":" + name
		if err := c.AddResource(id, s); err != nil {
			t.Fatal(err)
		}
		compiled, err := c.Compile(id)
		if err != nil {
			t.Fatalf("compile %s: %v", name, err)
		}
		fields[name] = fieldSchema{required: f.Required, schema: compiled}
	}
	return def, fields
}

// The carrier's fields, held to the convention: every required one present,
// each one present valid against its schema.
func checkCarrier(t *testing.T, fields map[string]fieldSchema, meta map[string]any) {
	t.Helper()
	for name, f := range fields {
		v, ok := meta[name]
		if !ok {
			if f.required {
				t.Errorf("_meta has no %s, which %s requires: %v", name, propagation, meta)
			}
			continue
		}
		raw, _ := json.Marshal(v)
		inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := f.schema.Validate(inst); err != nil {
			t.Errorf("_meta.%s = %s is not the convention's: %v", name, raw, err)
		}
	}
}

func TestRewriteNamesTheMethodsThePropagationDoes(t *testing.T) {
	def, _ := loadPropagation(t)
	if def.Carrier != "acp-meta" {
		t.Fatalf("carrier %q", def.Carrier)
	}
	var ours []string
	for m := range targets {
		ours = append(ours, m)
	}
	sort.Strings(ours)
	want := append([]string(nil), def.Methods...)
	sort.Strings(want)
	if strings.Join(ours, ",") != strings.Join(want, ",") {
		t.Fatalf("the rewrite handles %v, %s names %v", ours, propagation, want)
	}
}

func TestRewrittenMetaIsTheConventionsCarrier(t *testing.T) {
	def, fields := loadPropagation(t)
	for _, method := range def.Methods {
		for _, meta := range []string{
			`,"_meta":{"traceparent":"` + tp + `"}`,
			`,"_meta":{"traceparent":"` + tp + `","tracestate":"vendor=1"}`,
		} {
			telemetrytest.UseRecorder(t)
			in := line(method, meta)
			var before map[string]any
			if err := json.Unmarshal(in, &before); err != nil {
				t.Fatal(err)
			}
			checkCarrier(t, fields, before["params"].(map[string]any)["_meta"].(map[string]any))

			out := Rewrite(in, "acp_node_1")
			if bytes.Equal(out, in) {
				t.Fatalf("%s: nothing was rewritten", method)
			}
			var after map[string]any
			if err := json.Unmarshal(out, &after); err != nil {
				t.Fatalf("output is not JSON: %s", out)
			}
			got := after["params"].(map[string]any)["_meta"].(map[string]any)
			if got["traceparent"] == before["params"].(map[string]any)["_meta"].(map[string]any)["traceparent"] {
				t.Errorf("%s: the harness got the hub's span, not the node's", method)
			}
			checkCarrier(t, fields, got)
		}
	}
}

// A carrier the convention refuses (an all-zero trace id) is not continued:
// the frame goes through untouched rather than with a context made up.
func TestRewriteLeavesACarrierTheConventionRefuses(t *testing.T) {
	_, fields := loadPropagation(t)
	telemetrytest.UseRecorder(t)
	zero := "00-00000000000000000000000000000000-b7ad6b7169203331-01"
	raw, _ := json.Marshal(zero)
	inst, _ := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if fields["traceparent"].schema.Validate(inst) == nil {
		t.Fatal("the convention accepts an all-zero trace id")
	}
	in := line("session/prompt", `,"_meta":{"traceparent":"`+zero+`"}`)
	if out := Rewrite(in, "acp_node_1"); !bytes.Equal(out, in) {
		t.Fatalf("rewritten:\n%s", out)
	}
}

// The vendored conventions are treaty's at the release AgentPod pins, byte
// for byte: VERSION names treaty.json's pin, and when the hub's installed
// treaty is in this checkout, the copy equals its file.
func TestVendoredConventionsAreThePinnedRelease(t *testing.T) {
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
	version, err := os.ReadFile(filepath.Join("testdata", "treaty", "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(version)) != pin.Treaty {
		t.Fatalf("vendored treaty is %q, treaty.json pins %q: copy suite.v1.json again", strings.TrimSpace(string(version)), pin.Treaty)
	}
	installed := filepath.Join(root, "apps", "hub", "node_modules", "@superjackfruitlabs", "treaty-contracts", "data", "schemas", "telemetry", "suite.v1.json")
	upstream, err := os.ReadFile(installed)
	if err != nil {
		t.Skipf("the hub's treaty is not installed in this checkout: %v", err)
	}
	got, err := os.ReadFile(vendoredConventions)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, upstream) {
		t.Error("suite.v1.json differs from the installed treaty's; copy it again")
	}
}
