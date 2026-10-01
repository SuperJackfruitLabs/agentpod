package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Hermes can serve its profiles two ways, and the node-agent has to be right about both.
//
//	standalone   one `hermes -p <name> gateway run` process per profile. The node-agent
//	             finds each profile's own process, so health is honest per-agent.
//	multiplex    ONE `hermes gateway run` serves every profile
//	             (`gateway.multiplex_profiles: true`). No profile has a process of its own.
//
// Guild migrated to multiplex on 2026-10-02 and every station on it immediately read
// `stopped`, uptime null, 0 MB — because the only path that reported a profile via the root
// gateway was `servesRootGateway`, which matches on a SHARED MATRIX IDENTITY. Multiplexed
// profiles each keep their own `@agent_<name>` identity, so it returned false for all of
// them and the pgrep fell through to looking for a per-profile process that no longer exists.
//
// Dispatch never broke (the hub's readiness check never reads Running), so this was fifteen
// agents working normally while every surface a person looks at said they were down.
//
// The fix must not assume multiplex: standalone installations are still the common case, and
// a host part-way through a migration can have both. Hence the ordering these tests pin —
// a profile's OWN process is the most specific evidence available and always wins.

// multiplexHome builds a Hermes home where profiles have their own distinct identities
// (the ordinary case) and the root config may or may not enable multiplexing.
func multiplexHome(t *testing.T, gatewayBlock string) string {
	t.Helper()
	home := t.TempDir()
	writeEnv := func(dir, mxid string) {
		t.Helper()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
		body := fmt.Sprintf("MATRIX_HOMESERVER=https://id.agentpod.dev\nMATRIX_USER_ID=%s\nMATRIX_ACCESS_TOKEN=syt_SECRET_TOKEN\n", mxid)
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(body), 0o600); err != nil {
			t.Fatalf("write .env: %v", err)
		}
	}
	writeEnv(home, "@host:id.agentpod.dev")
	writeEnv(filepath.Join(home, "profiles", "artistic-lyra"), "@agent_artistic-lyra:id.agentpod.dev")
	writeEnv(filepath.Join(home, "profiles", "coder-kai"), "@agent_coder-kai:id.agentpod.dev")

	if gatewayBlock != "" {
		if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte(gatewayBlock), 0o644); err != nil {
			t.Fatalf("write config.yaml: %v", err)
		}
	}
	return home
}

func TestMultiplexProfilesReadsTheGatewayBlock(t *testing.T) {
	for _, tc := range []struct {
		name string
		yaml string
		want bool
	}{
		{"no config at all", "", false},
		{"enabled", "gateway:\n  multiplex_profiles: true\n", true},
		{"explicitly disabled", "gateway:\n  multiplex_profiles: false\n", false},
		{"enabled among siblings", "gateway:\n  port: 8080\n  multiplex_profiles: true\n  foo: bar\n", true},
		{"gateway block absent", "stt:\n  enabled: true\n", false},
		{
			// The key must be read from the `gateway` block and nowhere else: a same-named
			// key under another top-level section is a different setting, and treating it as
			// this one would silently report every station through the root gateway on a host
			// that never multiplexed anything.
			"same key under another section",
			"plugins:\n  multiplex_profiles: true\ngateway:\n  port: 8080\n",
			false,
		},
		{
			// Order must not matter: the gateway block may come after other sections.
			"gateway block last",
			"stt:\n  enabled: true\ngateway:\n  multiplex_profiles: true\n",
			true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHermes(multiplexHome(t, tc.yaml)).(*hermesDescriptor)
			if got := h.multiplexProfiles(); got != tc.want {
				t.Errorf("multiplexProfiles() = %v, want %v for config:\n%s", got, tc.want, tc.yaml)
			}
		})
	}
}

// TestDetectWithholdsLifecycleWhenMultiplexed: with one process serving every profile there
// is no per-profile gateway to start or stop, so offering `lifecycle` would offer a Start
// that puts a SECOND gateway on a profile the multiplexer already serves — the same
// duplication #273 was about, reached by a different route.
func TestDetectWithholdsLifecycleWhenMultiplexed(t *testing.T) {
	h := NewHermes(multiplexHome(t, "gateway:\n  multiplex_profiles: true\n"))
	stations, err := h.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	var checked int
	for _, s := range stations {
		if !strings.HasPrefix(s.Key, "hermes:") {
			continue
		}
		checked++
		if slices.Contains(s.Capabilities, "lifecycle") {
			t.Errorf("%s advertises lifecycle under multiplex; it has no gateway of its own", s.Key)
		}
		if !slices.Contains(s.Capabilities, "acp") {
			t.Errorf("%s lost acp — it must stay dispatchable; only lifecycle is withheld", s.Key)
		}
	}
	if checked != 2 {
		t.Fatalf("checked %d profile stations, want 2", checked)
	}
}

// TestDetectKeepsLifecycleWhenStandalone is the regression that protects every installation
// that has NOT migrated. These hosts are the common case and must behave exactly as before.
func TestDetectKeepsLifecycleWhenStandalone(t *testing.T) {
	for _, tc := range []struct{ name, yaml string }{
		{"no config", ""},
		{"multiplex off", "gateway:\n  multiplex_profiles: false\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHermes(multiplexHome(t, tc.yaml))
			stations, err := h.Detect()
			if err != nil {
				t.Fatalf("Detect: %v", err)
			}
			for _, s := range stations {
				if !strings.HasPrefix(s.Key, "hermes:") {
					continue
				}
				if !slices.Contains(s.Capabilities, "lifecycle") {
					t.Errorf("%s lost lifecycle on a standalone host", s.Key)
				}
			}
		})
	}
}

// TestStartRefusesUnderMultiplex — and says WHY in terms of multiplexing, not in terms of a
// shared Matrix identity. The identity message would be actively misleading here: these
// profiles have their own identities, and an operator told otherwise would go looking for a
// problem that does not exist.
func TestStartRefusesUnderMultiplex(t *testing.T) {
	h := NewHermes(multiplexHome(t, "gateway:\n  multiplex_profiles: true\n"))
	err := h.(*hermesDescriptor).Start("hermes:artistic-lyra")
	if err == nil {
		t.Fatal("Start succeeded under multiplex; it must refuse")
	}
	msg := strings.ToLower(err.Error())
	if !strings.Contains(msg, "multiplex") {
		t.Errorf("refusal does not mention multiplexing, so it cannot be acted on: %q", err)
	}
	if strings.Contains(msg, "same matrix identity") {
		t.Errorf("refusal blames a shared Matrix identity, which is not why: %q", err)
	}
}

// TestProbeTargetOrdering pins the decision Health makes, as a pure function so every host
// shape is testable without stubbing the process table.
//
// The ordering is the whole fix: a profile's own process is the most specific evidence there
// is, so it wins even when the config says multiplex. That is what keeps a host part-way
// through a migration — or one where an operator started a standalone gateway by hand —
// reporting what is actually true rather than what the config implies.
func TestProbeTargetOrdering(t *testing.T) {
	const key = "hermes:artistic-lyra"
	for _, tc := range []struct {
		name              string
		perProfileRunning bool
		servedByRoot      bool
		wantProbe         string
		wantRootView      bool
	}{
		{"standalone, running", true, false, key, false},
		{"standalone, stopped", false, false, key, false},
		{"multiplexed", false, true, "hermes", true},
		{"multiplexed but a standalone gateway is also up", true, true, key, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probe, rootView := probeTarget(key, tc.perProfileRunning, tc.servedByRoot)
			if probe != tc.wantProbe || rootView != tc.wantRootView {
				t.Errorf("probeTarget(%q, %v, %v) = (%q, %v), want (%q, %v)",
					key, tc.perProfileRunning, tc.servedByRoot, probe, rootView, tc.wantProbe, tc.wantRootView)
			}
		})
	}
}
