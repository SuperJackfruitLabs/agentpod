package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSkillsStationVerifyUsesTheManagedVerificationRoute(t *testing.T) {
	bin := build(t)
	var gotMethod, gotPath, gotAuth string
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"state":"verified"}`))
	}))
	defer srv.Close()

	out, code := run(t, bin, []string{
		"AGENTPOD_HUB=" + srv.URL,
		"AGENTPOD_TOKEN=" + jwtish("prn_operator", "human"),
	}, "skills", "station", "verify", "--station", "station_fixture", "--profile", "fixture")
	if code != 0 {
		t.Fatalf("verify failed (%d): %s", code, out)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/stations/station_fixture/skills/verify" {
		t.Fatalf("verify route = %s %s", gotMethod, gotPath)
	}
	if !strings.HasPrefix(gotAuth, "Bearer ") {
		t.Fatalf("missing bearer authorization: %q", gotAuth)
	}
	if gotBody["profile"] != "fixture" {
		t.Fatalf("verify body = %#v", gotBody)
	}
	if !strings.Contains(out, `"state":"verified"`) {
		t.Fatalf("verify result was not preserved: %s", out)
	}
}

func TestSkillsArtifactDeleteUsesTheOwnedArtifactRoute(t *testing.T) {
	bin := build(t)
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deleted":true}`))
	}))
	defer srv.Close()

	const id = "11111111-1111-4111-8111-111111111111"
	out, code := run(t, bin, []string{
		"AGENTPOD_HUB=" + srv.URL,
		"AGENTPOD_TOKEN=" + jwtish("prn_operator", "human"),
	}, "skills", "artifact", "delete", "--id", id)
	if code != 0 {
		t.Fatalf("delete failed (%d): %s", code, out)
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/skills/artifacts/"+id {
		t.Fatalf("delete route = %s %s", gotMethod, gotPath)
	}
	if !strings.HasPrefix(gotAuth, "Bearer ") {
		t.Fatalf("missing bearer authorization: %q", gotAuth)
	}
	if !strings.Contains(out, `"deleted":true`) {
		t.Fatalf("delete result was not preserved: %s", out)
	}
}

func TestSkillsArtifactDeleteRequiresAnExplicitID(t *testing.T) {
	bin := build(t)
	out, code := run(t, bin, nil, "skills", "artifact", "delete")
	if code != 2 || !strings.Contains(out, "--id ARTIFACT_ID") {
		t.Fatalf("missing ID should refuse with usage (code %d): %s", code, out)
	}
}
