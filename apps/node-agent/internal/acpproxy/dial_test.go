package acpproxy

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

func TestProxyURLDerivesTheSchemeLikeTheGateway(t *testing.T) {
	cases := []struct{ hub, want string }{
		{"https://hub.agentpod.dev", "wss://hub.agentpod.dev/api/acp/proxy"},
		{"http://localhost:3001", "ws://localhost:3001/api/acp/proxy"},
		{"https://hub.agentpod.dev/", "wss://hub.agentpod.dev/api/acp/proxy"}, // trailing slash
	}
	for _, c := range cases {
		got := ProxyURL(c.hub, "station_1", "")
		if !strings.HasPrefix(got, c.want) {
			t.Errorf("ProxyURL(%q) = %q, want prefix %q", c.hub, got, c.want)
		}
	}
}

func TestProxyURLCarriesTheTarget(t *testing.T) {
	u, err := url.Parse(ProxyURL("https://h", "station_1", ""))
	if err != nil {
		t.Fatal(err)
	}
	if got := u.Query().Get("station"); got != "station_1" {
		t.Errorf("station = %q", got)
	}
	if u.Query().Has("session") {
		t.Error("an empty session must not be sent as a blank parameter")
	}

	u2, _ := url.Parse(ProxyURL("https://h", "", "acps_9"))
	if got := u2.Query().Get("session"); got != "acps_9" {
		t.Errorf("session = %q", got)
	}
}

func TestProxyURLEscapesTheTarget(t *testing.T) {
	// Ids come from a command line. An unescaped one could smuggle another
	// query parameter into the request.
	u, err := url.Parse(ProxyURL("https://h", "station_1&admin=true", ""))
	if err != nil {
		t.Fatal(err)
	}
	if u.Query().Get("admin") != "" {
		t.Error("a crafted station id injected a second query parameter")
	}
	if u.Query().Get("station") != "station_1&admin=true" {
		t.Errorf("station round-tripped as %q", u.Query().Get("station"))
	}
}

func TestValidateTargetRefusesToGuess(t *testing.T) {
	// Guessing the wrong station starts an agent on the wrong machine, in
	// someone's real workspace. Refusing is the kinder failure.
	if err := ValidateTarget("", ""); err == nil {
		t.Error("expected an error when neither --station nor --session is given")
	}
	if err := ValidateTarget("station_1", ""); err != nil {
		t.Errorf("--station alone should be valid: %v", err)
	}
	if err := ValidateTarget("", "acps_1"); err != nil {
		t.Errorf("--session alone should be valid: %v", err)
	}
}

func TestDialRequiresAToken(t *testing.T) {
	// Checked before any network call, so a missing token is an instant, clear
	// error rather than a confusing 401 after a round-trip.
	_, err := Dial(context.Background(), "https://h", "", "station_1", "")
	if err == nil || !strings.Contains(err.Error(), "AGENTPOD_TOKEN") {
		t.Errorf("err = %v, want a message naming AGENTPOD_TOKEN", err)
	}
}

func TestDialRefusesAnUntargetedInvocation(t *testing.T) {
	_, err := Dial(context.Background(), "https://h", "tok", "", "")
	if err == nil || !strings.Contains(err.Error(), "--station") {
		t.Errorf("err = %v, want a message naming --station", err)
	}
}
