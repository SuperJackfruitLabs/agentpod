package descriptor

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Whether the thing an ACP bridge talks THROUGH is reachable.
//
// Distinct from Health.Running, which is a pgrep, and that distinction is the whole
// reason this exists. On ashram, 2026-10-03, the OpenClaw gateway process was alive and
// its socket was not: the agent had restarted the gateway it ran through, and the
// gateway's bind ("tailnet") contradicted its mode ("local"), so it listened on the
// tailnet address while every client dialled loopback. `pgrep` said running. Three
// prompts in a row came back as a bare "Internal error".
//
// A process check could never have told those apart. A dial can.

func TestOpenClawGatewayAddress_PrefersConfiguredURL(t *testing.T) {
	// A configured URL points at a gateway that may not be on this host at all, so it
	// wins over anything read from local config.
	for _, tc := range []struct{ url, want string }{
		{"ws://10.0.0.4:9999", "10.0.0.4:9999"},
		{"wss://gateway.example.com:443/acp", "gateway.example.com:443"},
		// No port in the URL: ws is 80, wss is 443, as any URL parser would.
		{"ws://gateway.example.com", "gateway.example.com:80"},
		{"wss://gateway.example.com", "gateway.example.com:443"},
	} {
		got, err := openclawGatewayAddress(tc.url, 0)
		if err != nil {
			t.Fatalf("openclawGatewayAddress(%q): %v", tc.url, err)
		}
		if got != tc.want {
			t.Errorf("openclawGatewayAddress(%q) = %q, want %q", tc.url, got, tc.want)
		}
	}
}

func TestOpenClawGatewayAddress_FallsBackToLoopbackAndConfiguredPort(t *testing.T) {
	// With no URL the bridge dials the local gateway, which is loopback by openclaw's
	// own default. The port comes from openclaw's config.
	got, err := openclawGatewayAddress("", 18999)
	if err != nil {
		t.Fatalf("openclawGatewayAddress: %v", err)
	}
	if got != "127.0.0.1:18999" {
		t.Errorf("got %q, want 127.0.0.1:18999", got)
	}
}

func TestOpenClawGatewayAddress_DefaultsThePortWhenConfigSaysNothing(t *testing.T) {
	got, err := openclawGatewayAddress("", 0)
	if err != nil {
		t.Fatalf("openclawGatewayAddress: %v", err)
	}
	if got != "127.0.0.1:18789" {
		t.Errorf("got %q, want 127.0.0.1:18789", got)
	}
}

func TestOpenClawGatewayAddress_RejectsAnUnparseableURL(t *testing.T) {
	// Silently falling back to loopback would probe the WRONG gateway and report it
	// healthy — a confident wrong answer, which is worse than no answer.
	if _, err := openclawGatewayAddress("://nonsense", 0); err == nil {
		t.Fatal("expected an error for an unparseable gateway URL")
	}
}

func TestOpenClawConfigPort_ReadsTheConfiguredPort(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, "openclaw.json"), map[string]any{
		"gateway": map[string]any{"port": 18999},
	})
	if got := openclawConfigPort(home); got != 18999 {
		t.Errorf("openclawConfigPort = %d, want 18999", got)
	}
}

func TestOpenClawConfigPort_ZeroWhenUnreadable(t *testing.T) {
	// Zero means "config said nothing"; the caller supplies openclaw's default. A
	// missing or malformed config must not stop a probe from happening at all.
	if got := openclawConfigPort(t.TempDir()); got != 0 {
		t.Errorf("missing config: got %d, want 0", got)
	}
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "openclaw.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := openclawConfigPort(home); got != 0 {
		t.Errorf("malformed config: got %d, want 0", got)
	}
}

func TestOpenClawProbeTransport_ReachableWhenTheDialSucceeds(t *testing.T) {
	d := &openclawDescriptor{
		home:       t.TempDir(),
		gatewayURL: "ws://127.0.0.1:18789",
		dial: func(network, addr string, _ time.Duration) (net.Conn, error) {
			if network != "tcp" {
				t.Errorf("dialled %q, want tcp", network)
			}
			if addr != "127.0.0.1:18789" {
				t.Errorf("dialled %q, want 127.0.0.1:18789", addr)
			}
			return nil, nil
		},
	}

	probe := d.ProbeTransport("openclaw:buddhimaan")

	if !probe.Reachable {
		t.Errorf("Reachable = false, want true (detail %q)", probe.Detail)
	}
	if probe.Address != "127.0.0.1:18789" {
		t.Errorf("Address = %q", probe.Address)
	}
}

func TestOpenClawProbeTransport_UnreachableCarriesTheRefusal(t *testing.T) {
	// The incident's exact shape: the process is up, the socket refuses. The reason
	// is carried because "unreachable" alone sends a reader back to the logs.
	d := &openclawDescriptor{
		home: t.TempDir(),
		dial: func(string, string, time.Duration) (net.Conn, error) {
			return nil, errors.New("connect: connection refused")
		},
	}

	probe := d.ProbeTransport("openclaw")

	if probe.Reachable {
		t.Fatal("Reachable = true, want false")
	}
	if probe.Detail == "" {
		t.Error("want the dial's own words in Detail, got none")
	}
	if probe.Address != "127.0.0.1:18789" {
		t.Errorf("Address = %q, want the address it tried", probe.Address)
	}
}

func TestOpenClawProbeTransport_UnreachableWhenTheAddressCannotBeResolved(t *testing.T) {
	// It must answer, never panic or report a reachable gateway it never dialled.
	dialled := false
	d := &openclawDescriptor{
		home:       t.TempDir(),
		gatewayURL: "://nonsense",
		dial: func(string, string, time.Duration) (net.Conn, error) {
			dialled = true
			return nil, nil
		},
	}

	probe := d.ProbeTransport("openclaw")

	if probe.Reachable {
		t.Error("Reachable = true for an address that could not be resolved")
	}
	if dialled {
		t.Error("dialled despite having no address to dial")
	}
}

func TestOpenClawProbeTransport_ImplementsTransportProber(t *testing.T) {
	// The hub resolves this by interface, so a build that silently stopped
	// satisfying it would make every probe answer "unknown" rather than fail loudly.
	var _ TransportProber = (*openclawDescriptor)(nil)
}

func write(t *testing.T, path string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}
