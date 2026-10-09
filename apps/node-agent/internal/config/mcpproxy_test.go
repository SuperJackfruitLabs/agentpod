package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The station list is edited in place: every other key — including one this binary does not know,
// which a Load/Save round trip would drop — survives, and the file stays owner-only.
func TestSetMCPProxyStationsEditsOnlyTheStationList(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	orig := `{"hub":"http://h","nodeId":"n","nodeSecret":"s","futureKey":{"x":1},"mcpProxy":{"stations":["a"],"superlibraryUrl":"https://lib.example/mcp"}}`
	if err := os.WriteFile(p, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SetMCPProxyStations(p, []string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got["futureKey"], map[string]any{"x": float64(1)}) || got["nodeSecret"] != "s" {
		t.Fatalf("other keys were not preserved: %s", b)
	}
	mp := got["mcpProxy"].(map[string]any)
	if !reflect.DeepEqual(mp["stations"], []any{"a", "b"}) || mp["superlibraryUrl"] != "https://lib.example/mcp" {
		t.Fatalf("mcpProxy = %v", mp)
	}
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("config mode %v; want 0600", fi.Mode().Perm())
	}
	entries, _ := os.ReadDir(filepath.Dir(p))
	if len(entries) != 1 {
		t.Fatalf("left %d files behind; want the config alone (atomic rename)", len(entries))
	}
	c, err := Load(p)
	if err != nil || c.MCPProxy == nil || !reflect.DeepEqual(c.MCPProxy.Stations, []string{"a", "b"}) {
		t.Fatalf("Load after edit: %+v %v", c.MCPProxy, err)
	}
}

func TestSetMCPProxyStationsCreatesTheSectionWhenAbsent(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	os.WriteFile(p, []byte(`{"hub":"http://h"}`), 0o600)
	if err := SetMCPProxyStations(p, []string{"a"}); err != nil {
		t.Fatal(err)
	}
	c, _ := Load(p)
	if c.MCPProxy == nil || len(c.MCPProxy.Stations) != 1 {
		t.Fatalf("got %+v", c.MCPProxy)
	}
	if err := SetMCPProxyStations(p, nil); err != nil {
		t.Fatal(err)
	}
	c, _ = Load(p)
	if c.MCPProxy == nil || len(c.MCPProxy.Stations) != 0 {
		t.Fatalf("emptying kept %+v", c.MCPProxy)
	}
}

func TestSetMCPProxyStationsRefusesAMissingConfig(t *testing.T) {
	if err := SetMCPProxyStations(filepath.Join(t.TempDir(), "nope.json"), []string{"a"}); err == nil {
		t.Fatal("wrote a config for a node that is not enrolled")
	}
}
