package forgeapi

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const sharedBase = `# operator-authored: services every station needs
services:
  slack:
    kind: webhook
    host: hooks.example.com
    env_var: SLACK_HOOK
  shared-forge:
    kind: forge
    provider: forgejo
    host: pkg.example.com
    auth: token
    scheme: token
    env_var: PKG_TOKEN
    repositories: [acme/pkg]
    preset: read
`

func serviceNode(t *testing.T, policy []byte, name string) map[string]any {
	t.Helper()
	var doc struct {
		Services map[string]map[string]any `yaml:"services"`
	}
	if err := yaml.Unmarshal(policy, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Services[name]
}

func labelsOfService(t *testing.T, policy []byte, name string) map[string]any {
	t.Helper()
	n := serviceNode(t, policy, name)
	if n == nil {
		t.Fatalf("service %q missing:\n%s", name, policy)
	}
	l, _ := n["labels"].(map[string]any)
	return l
}

func TestApplySharedCopiesEntriesAndMarksThem(t *testing.T) {
	out, skipped, err := ApplyShared(nil, []byte(sharedBase), "stn_1")
	if err != nil || len(skipped) != 0 {
		t.Fatalf("%v %v", err, skipped)
	}
	for _, name := range []string{"slack", "shared-forge"} {
		l := labelsOfService(t, out, name)
		if l["grant"] != "shared:"+name || l["station"] != "stn_1" {
			t.Errorf("%s labels = %v", name, l)
		}
	}
	if serviceNode(t, out, "slack")["host"] != "hooks.example.com" {
		t.Errorf("entry content not copied:\n%s", out)
	}
	if got := SharedServices(out); len(got) != 2 {
		t.Errorf("SharedServices = %v", got)
	}
	// a shared forge entry is not one of the hub's grants
	m, err := ManagedEntries(out)
	if err != nil || len(m) != 0 {
		t.Errorf("ManagedEntries sees shared entries as grants: %v %v", m, err)
	}
}

func TestApplySharedIsIdempotent(t *testing.T) {
	a, _, _ := ApplyShared(nil, []byte(sharedBase), "stn_1")
	b, _, err := ApplyShared(a, []byte(sharedBase), "stn_1")
	if err != nil || !bytes.Equal(a, b) {
		t.Fatalf("second apply changed the file (%v):\n%s\n---\n%s", err, a, b)
	}
}

func TestApplySharedRefreshesChangedAndRemovesDroppedEntries(t *testing.T) {
	a, _, _ := ApplyShared(nil, []byte(sharedBase), "stn_1")
	changed := strings.Replace(sharedBase, "hooks.example.com", "hooks2.example.com", 1)
	changed = changed[:strings.Index(changed, "  shared-forge:")] // dropped
	b, _, err := ApplyShared(a, []byte(changed), "stn_1")
	if err != nil {
		t.Fatal(err)
	}
	if serviceNode(t, b, "slack")["host"] != "hooks2.example.com" {
		t.Errorf("changed shared entry not refreshed:\n%s", b)
	}
	if serviceNode(t, b, "shared-forge") != nil {
		t.Errorf("dropped shared entry still present:\n%s", b)
	}
	// an absent shared file means no shared entries
	c, _, err := ApplyShared(b, nil, "stn_1")
	if err != nil || serviceNode(t, c, "slack") != nil {
		t.Errorf("shared file absent must remove shared entries: %v\n%s", err, c)
	}
}

func TestApplySharedNeverTouchesAStationsOwnEntries(t *testing.T) {
	own, err := MergePolicy([]byte("services:\n  operator-thing:\n    kind: webhook\n    host: ops.example.com\n"), baseEntry())
	if err != nil {
		t.Fatal(err)
	}
	// Shared names an entry with the station's own service name, another with its host, another
	// with a free name: own wins on both clashes, the free one is copied, nothing of the
	// station's own is changed or dropped.
	shared := `services:
  forge-forgejo-aaa111:
    kind: webhook
    host: elsewhere.example.com
  host-clash:
    kind: webhook
    host: forge.example.com
  fine:
    kind: webhook
    host: fine.example.com
`
	out, skipped, err := ApplyShared(own, []byte(shared), "stn_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(skipped) != 2 {
		t.Errorf("skipped = %v, want the name clash and the host clash", skipped)
	}
	if serviceNode(t, out, "fine") == nil || serviceNode(t, out, "host-clash") != nil {
		t.Errorf("wrong set copied:\n%s", out)
	}
	if serviceNode(t, out, "forge-forgejo-aaa111")["host"] != "forge.example.com" {
		t.Errorf("a grant entry was replaced by a shared one:\n%s", out)
	}
	m, _ := ManagedEntries(out)
	if len(m) != 1 || m[0].Grant != "fag_aaa111" {
		t.Errorf("grant entries = %v", m)
	}
	if serviceNode(t, out, "operator-thing") == nil {
		t.Errorf("operator entry lost")
	}
	// refreshing with the shared file gone keeps the station's own entries
	gone, _, _ := ApplyShared(out, nil, "stn_1")
	if serviceNode(t, gone, "fine") != nil || serviceNode(t, gone, "forge-forgejo-aaa111") == nil || serviceNode(t, gone, "operator-thing") == nil {
		t.Errorf("removing shared entries touched others:\n%s", gone)
	}
}

func TestApplySharedRejectsAnUnreadableSharedFile(t *testing.T) {
	_, _, err := ApplyShared(nil, []byte("services: [not, a, mapping]"), "stn_1")
	if !errors.Is(err, ErrBadSharedPolicy) {
		t.Fatalf("err = %v", err)
	}
	_, _, err = ApplyShared(nil, []byte("services:\n  \"bad name\":\n    kind: x\n"), "stn_1")
	if !errors.Is(err, ErrBadSharedPolicy) {
		t.Fatalf("bad service name: %v", err)
	}
}

func TestAGrantIdMayNotImpersonateTheSharedMarker(t *testing.T) {
	e := baseEntry()
	e.Grant = "shared:slack"
	if _, err := MergePolicy(nil, e); !errors.Is(err, ErrInvalidEntry) {
		t.Fatalf("err = %v", err)
	}
}

func TestRemoveEntriesCannotRemoveSharedEntries(t *testing.T) {
	a, _, _ := ApplyShared(nil, []byte(sharedBase), "stn_1")
	out, removed, err := RemoveEntries(a, map[string]bool{"shared:shared-forge": true, "shared:slack": true})
	if err != nil || len(removed) != 0 || !bytes.Equal(out, a) {
		t.Fatalf("removed %v %v", removed, err)
	}
}

// An emptied `services: {}` is parsed as flow style; entries added afterwards must still be block
// style, as stk's own loader and every human reading the file expect.
func TestEntriesAddedAfterTheSharedOnesWereRemovedStayBlockStyle(t *testing.T) {
	a, _, _ := ApplyShared(nil, []byte(sharedBase), "stn_1")
	b, _, err := ApplyShared(a, nil, "stn_1")
	if err != nil {
		t.Fatal(err)
	}
	c, err := MergePolicy(b, baseEntry())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(c), "{kind:") || strings.Contains(string(c), "services: {") {
		t.Fatalf("flow style:\n%s", c)
	}
}
