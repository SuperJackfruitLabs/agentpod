package salaam

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSkillInventorySeparatesPresentAdmittedLoadedAndExercised(t *testing.T) {
	workspace := "/private/workspace"
	loaded := true
	current := map[string]any{"version": 1, "revision": 1, "digest": strings.Repeat("c", 64), "bundles": []any{map[string]any{"path": ".salaam/skills/bundle", "digest": strings.Repeat("b", 64), "manifest_sha256": strings.Repeat("d", 64)}}, "state": "admitted", "loaded": nil, "loaded_reason": "admission alone is not proof", "entries": []any{map[string]any{"kind": "skill", "path": ".salaam/skills/bundle/skills/check/SKILL.md", "skill_id": "check", "sha256": strings.Repeat("a", 64), "bundle_digest": strings.Repeat("b", 64)}}}
	calls := 0
	c := &Client{Workspace: workspace, Runtime: &Runtime{run: func(context.Context, string, []string) ([]byte, error) {
		t.Fatal("inventory started daemon")
		return nil, nil
	}}, HTTP: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		calls++
		var value any
		switch r.URL.Path {
		case "/v1/sessions":
			value = []any{map[string]any{"id": "one", "cwd": workspace}, map[string]any{"id": "two", "cwd": workspace}, map[string]any{"id": "foreign", "cwd": "/foreign"}}
		case "/v1/sessions/one/context":
			value = current
		case "/v1/sessions/two/context":
			copy := map[string]any{}
			for k, v := range current {
				copy[k] = v
			}
			copy["loaded"] = loaded
			copy["loaded_reason"] = "actual current provider payload"
			value = copy
		default:
			t.Fatalf("unexpected passive inventory path: %s", r.URL.Path)
		}
		data, _ := json.Marshal(value)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})}}
	inventory, err := c.SkillInventory(context.Background(), StationKey(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if len(inventory.Skills) != 1 || inventory.Coverage.Complete {
		t.Fatalf("incorrect aggregation/coverage %+v", inventory)
	}
	skill := inventory.Skills[0]
	if skill.Evidence.Loaded.Value == nil || !*skill.Evidence.Loaded.Value || skill.Evidence.Exercised.Value != nil || skill.Evidence.Present.Value == nil || !*skill.Evidence.Present.Value {
		t.Fatalf("conflated evidence %+v", skill.Evidence)
	}
	if (!strings.Contains(skill.Evidence.Loaded.Reason, "session two") || !strings.Contains(skill.Evidence.Loaded.Reason, "session one")) || *skill.Source.ArtifactDigest == *skill.EntrypointDigest {
		t.Fatal("lost session or resource identity")
	}
	current["state"] = "stale"
	inventory, err = c.SkillInventory(context.Background(), StationKey(workspace))
	if err != nil {
		t.Fatal(err)
	}
	skill = inventory.Skills[0]
	if skill.Evidence.Loaded.Value == nil || *skill.Evidence.Loaded.Value || skill.Evidence.Present.Value != nil || skill.Evidence.Eligible.Value == nil || *skill.Evidence.Eligible.Value {
		t.Fatalf("stale admission looked loaded %+v", skill.Evidence)
	}
	current["state"] = "admitted"
	for _, mutation := range []map[string]any{{"digest": "invalid"}, {"version": 2}, {"state": "optimistic"}, {"bundles": []any{}}} {
		saved := map[string]any{}
		for k, v := range mutation {
			saved[k] = current[k]
			current[k] = v
		}
		if _, err := c.SkillInventory(context.Background(), StationKey(workspace)); err == nil {
			t.Fatalf("unbound inventory accepted: %+v", mutation)
		}
		for k, v := range saved {
			current[k] = v
		}
	}
	before := calls
	if _, err := c.SkillInventory(context.Background(), "salaam:foreign"); err == nil || calls != before {
		t.Fatal("foreign station reached private inventory")
	}
}
func TestSkillInventoryAdmissionWithoutPayloadKeepsLoadingUnknown(t *testing.T) {
	c := &Client{Workspace: "/work", HTTP: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		value := `[{"id":"one","cwd":"/work"}]`
		if r.URL.Path != "/v1/sessions" {
			value = `{"version":1,"revision":1,"digest":"` + strings.Repeat("c", 64) + `","bundles":[{"path":".salaam/skills/bundle","digest":"` + strings.Repeat("b", 64) + `","manifest_sha256":"` + strings.Repeat("d", 64) + `"}],"state":"admitted","loaded":null,"loaded_reason":"not loaded","entries":[{"kind":"skill","path":".salaam/skills/bundle/skills/check/SKILL.md","skill_id":"check","sha256":"` + strings.Repeat("a", 64) + `","bundle_digest":"` + strings.Repeat("b", 64) + `"}]}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(value))}, nil
	})}}
	got, err := c.SkillInventory(context.Background(), StationKey("/work"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Skills) != 1 || got.Skills[0].Evidence.Loaded.Value != nil || got.Skills[0].Evidence.Loaded.ObservedAt != nil {
		t.Fatal("installed/admitted content became loaded")
	}
}
