package gateway

import (
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"
)

type fakeProxy struct {
	stations []string
	rotated  []string
	setErr   error
}

func (f *fakeProxy) Stations() []string { return append([]string(nil), f.stations...) }
func (f *fakeProxy) SetStations(ids []string) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.stations = append([]string(nil), ids...)
	return nil
}
func (f *fakeProxy) Rotate(ids []string) ([]string, error) {
	if len(ids) == 0 {
		ids = f.stations
	}
	f.rotated = ids
	return ids, nil
}

func manage(t *testing.T, proxy *fakeProxy, persist func([]string) error) Handler {
	t.Helper()
	if persist == nil {
		persist = func([]string) error { return nil }
	}
	return NewMCPProxyManageHandler(gitIdentityPassthrough(), proxy, persist)
}

func call(t *testing.T, h Handler, verb, params string) (any, error) {
	t.Helper()
	got, _, err := h.Handle(t.Context(), verb, json.RawMessage(params), nil)
	return got, err
}

func TestMCPProxyManagePassesOtherVerbsThrough(t *testing.T) {
	got, err := call(t, manage(t, &fakeProxy{}, nil), "health", `{}`)
	if err != nil || got != "inner:health" {
		t.Fatalf("got %v %v", got, err)
	}
}

func TestMCPProxyStatusNamesStationsAndNothingElse(t *testing.T) {
	got, err := call(t, manage(t, &fakeProxy{stations: []string{"a", "b"}}, nil), "mcp.proxy.status", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	if string(b) != `{"running":true,"stations":["a","b"]}` {
		t.Fatalf("status = %s", b)
	}
}

func TestMCPProxySetPersistsThenAppliesTheDelta(t *testing.T) {
	proxy := &fakeProxy{stations: []string{"a", "b"}}
	var persisted []string
	h := manage(t, proxy, func(s []string) error { persisted = s; return nil })
	got, err := call(t, h, "mcp.proxy.set", `{"enable":["c","a"],"disable":["b"]}`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a", "c"}
	if !reflect.DeepEqual(persisted, want) || !reflect.DeepEqual(proxy.stations, want) {
		t.Fatalf("persisted %v, serving %v; want %v", persisted, proxy.stations, want)
	}
	b, _ := json.Marshal(got)
	if string(b) != `{"stations":["a","c"]}` {
		t.Fatalf("result %s", b)
	}
}

// The config is written first: a proxy serving a station its config does not name would lose it
// at the next restart, and nobody would know why.
func TestMCPProxySetChangesNothingWhenTheConfigCannotBeWritten(t *testing.T) {
	proxy := &fakeProxy{stations: []string{"a"}}
	h := manage(t, proxy, func([]string) error { return errors.New("read-only file system") })
	if _, err := call(t, h, "mcp.proxy.set", `{"enable":["b"]}`); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("err = %v", err)
	}
	if !reflect.DeepEqual(proxy.stations, []string{"a"}) {
		t.Fatalf("serving %v after a failed write", proxy.stations)
	}
}

func TestMCPProxySetRefusesAnInvalidStationID(t *testing.T) {
	if _, err := call(t, manage(t, &fakeProxy{}, nil), "mcp.proxy.set", `{"enable":["a/b"]}`); err == nil {
		t.Fatal("accepted a station id that cannot be a path segment")
	}
}

func TestMCPProxyRotateNamedOrAll(t *testing.T) {
	proxy := &fakeProxy{stations: []string{"a", "b"}}
	h := manage(t, proxy, nil)
	got, err := call(t, h, "mcp.proxy.rotate", `{"stations":["a"]}`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	if string(b) != `{"rotated":["a"]}` {
		t.Fatalf("rotate a = %s", b)
	}
	if _, err := call(t, h, "mcp.proxy.rotate", `{}`); err != nil {
		t.Fatal(err)
	}
	r := append([]string(nil), proxy.rotated...)
	sort.Strings(r)
	if !reflect.DeepEqual(r, []string{"a", "b"}) {
		t.Fatalf("rotate all rotated %v", r)
	}
}
