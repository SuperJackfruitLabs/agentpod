package fleetcred

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const devCred = "dev_0123456789abcdef0123:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"

// fakePlane is the hub (discovery) and the plane in one server; polls answer pending N times.
func fakePlane(t *testing.T, pendingPolls int) (*httptest.Server, *[]string) {
	t.Helper()
	var seen []string
	var srv *httptest.Server
	srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/public/org-plane":
			_ = json.NewEncoder(w).Encode(map[string]string{"issuer": srv.URL, "url": srv.URL, "audience": "https://hub.test"})
		case "/api/auth/device/code":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["client_id"] != "apn" || body["scope"] != "openid" {
				t.Errorf("device/code body = %v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code": "dc1", "user_code": "ABCD-EFGH", "verification_uri": srv.URL + "/device",
				"verification_uri_complete": srv.URL + "/device?user_code=ABCD-EFGH", "expires_in": 600, "interval": 5,
			})
		case "/api/auth/device/token":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["grant_type"] != "urn:ietf:params:oauth:grant-type:device_code" || body["device_code"] != "dc1" || body["client_id"] != "apn" {
				t.Errorf("device/token body = %v", body)
			}
			if pendingPolls > 0 {
				pendingPolls--
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
				return
			}
			_, _ = w.Write([]byte(`{"device_credential":"` + devCred + `"}`))
		case "/api/token/device":
			if got := r.Header.Get("Authorization"); got != "Bearer "+devCred {
				t.Errorf("exchange presented %q", got)
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["audience"] != "https://hub.test" {
				t.Errorf("audience = %q", body["audience"])
			}
			_, _ = w.Write([]byte(`{"access_token":"plane-token","token_type":"Bearer","expires_in":300}`))
		default:
			http.NotFound(w, r)
		}
	}))
	// Started only after srv is assigned: the handler reads srv.URL.
	srv.Start()
	return srv, &seen
}

func TestDiscoverPlaneLegacyAndConfigured(t *testing.T) {
	legacy := httptest.NewServer(http.NotFoundHandler())
	defer legacy.Close()
	if p, err := DiscoverPlane(legacy.URL); p != nil || err != nil {
		t.Fatalf("404 must mean legacy, got %+v %v", p, err)
	}
	null := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"issuer":null}`)) }))
	defer null.Close()
	if p, err := DiscoverPlane(null.URL); p != nil || err != nil {
		t.Fatalf("issuer:null must mean legacy, got %+v %v", p, err)
	}
	srv, _ := fakePlane(t, 0)
	defer srv.Close()
	p, err := DiscoverPlane(srv.URL)
	if err != nil || p == nil || p.Audience != "https://hub.test" {
		t.Fatalf("got %+v %v", p, err)
	}
}

func TestDeviceFlowWaitsThroughPendingAndHonoursTheInterval(t *testing.T) {
	srv, _ := fakePlane(t, 2)
	defer srv.Close()
	p := Plane{Issuer: srv.URL, URL: srv.URL, Audience: "https://hub.test"}
	dc, err := StartDeviceFlow(p)
	if err != nil {
		t.Fatal(err)
	}
	var slept []time.Duration
	d, err := WaitForDevice(p, dc, func(s time.Duration) { slept = append(slept, s) })
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != "dev_0123456789abcdef0123" || !strings.HasPrefix(d.Secret, "AbCd") || d.PlaneURL != srv.URL || d.Audience != "https://hub.test" {
		t.Fatalf("device = %+v", d)
	}
	if len(slept) != 3 || slept[0] != 5*time.Second {
		t.Fatalf("slept %v, want three waits of the 5s interval", slept)
	}
}

func TestSlowDownAddsFiveSeconds(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":"slow_down"}`))
			return
		}
		_, _ = w.Write([]byte(`{"device_credential":"` + devCred + `"}`))
	}))
	defer srv.Close()
	var slept []time.Duration
	_, err := WaitForDevice(Plane{URL: srv.URL}, DeviceCode{DeviceCode: "dc", Interval: 5, ExpiresIn: 600}, func(s time.Duration) { slept = append(slept, s) })
	if err != nil {
		t.Fatal(err)
	}
	if slept[1] != 10*time.Second {
		t.Fatalf("after slow_down the wait should grow to 10s, slept %v", slept)
	}
}

func TestAccessDeniedStopsAtOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"access_denied"}`))
	}))
	defer srv.Close()
	_, err := WaitForDevice(Plane{URL: srv.URL}, DeviceCode{DeviceCode: "dc", Interval: 5, ExpiresIn: 600}, func(time.Duration) {})
	if !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("err = %v", err)
	}
}

func TestAMalformedDeviceCredentialIsRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"an RFC 8628 token response, not ours"}`))
	}))
	defer srv.Close()
	if _, err := PollDeviceToken(Plane{URL: srv.URL}, "dc"); err == nil {
		t.Fatal("a response without device_credential must be an error")
	}
}

func TestResolveExchangesAPlaneDeviceAtThePlane(t *testing.T) {
	withConfigDir(t)
	srv, seen := fakePlane(t, 0)
	defer srv.Close()
	hub := srv.URL
	if err := SaveDevice(Device{ID: "dev_0123456789abcdef0123", Secret: strings.SplitN(devCred, ":", 2)[1], Hub: hub, PlaneURL: srv.URL, Audience: "https://hub.test"}); err != nil {
		t.Fatal(err)
	}
	c, err := Resolve(hub)
	if err != nil || c.Token != "plane-token" {
		t.Fatalf("Resolve = %+v %v", c, err)
	}
	for _, s := range *seen {
		if strings.HasPrefix(s, "POST /api/auth/devices/token") {
			t.Fatal("a plane credential must never be sent to the hub's exchange")
		}
	}
}

// A hub that names an issuer but not where to reach it (or for which audience) is misconfigured;
// guessing would send the device secret somewhere nobody named.
func TestDiscoverPlaneRefusesAnIncompleteAnswer(t *testing.T) {
	for _, body := range []string{
		`{"issuer":"https://accounts.test","audience":"https://hub.test"}`,
		`{"issuer":"https://accounts.test","url":"https://accounts.test"}`,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }))
		p, err := DiscoverPlane(srv.URL)
		srv.Close()
		if err == nil || p != nil {
			t.Fatalf("%s: want an error, got %+v %v", body, p, err)
		}
	}
}

func TestAnExpiredCodeStopsTheWait(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"expired_token"}`))
	}))
	defer srv.Close()
	_, err := WaitForDevice(Plane{URL: srv.URL}, DeviceCode{DeviceCode: "dc", Interval: 5, ExpiresIn: 600}, func(time.Duration) {})
	if !errors.Is(err, ErrDeviceCodeExpired) {
		t.Fatalf("err = %v", err)
	}
}

func TestTheWaitEndsWhenTheCodeLifetimeIsSpent(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		polls++
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
	}))
	defer srv.Close()
	_, err := WaitForDevice(Plane{URL: srv.URL}, DeviceCode{DeviceCode: "dc", Interval: 5, ExpiresIn: 15}, func(time.Duration) {})
	if !errors.Is(err, ErrDeviceCodeExpired) || polls != 3 {
		t.Fatalf("err = %v after %d polls, want expiry after 3", err, polls)
	}
}

func TestLegacyDeviceStillExchangesAtTheHub(t *testing.T) {
	withConfigDir(t)
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		_, _ = w.Write([]byte(`{"token":"hub-token"}`))
	}))
	defer srv.Close()
	if err := SaveDevice(Device{ID: "dev_0123456789abcdef0123", Secret: "s", Hub: srv.URL}); err != nil {
		t.Fatal(err)
	}
	c, err := Resolve(srv.URL)
	if err != nil || c.Token != "hub-token" {
		t.Fatalf("Resolve = %+v %v", c, err)
	}
	if len(seen) != 1 || seen[0] != "POST /api/auth/devices/token" {
		t.Fatalf("legacy exchange went to %v", seen)
	}
}
