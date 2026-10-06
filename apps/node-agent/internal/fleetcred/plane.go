package fleetcred

// Signing in through the organization plane (issuer contract §3.2).
//
// A hub that defers to an organization plane says so at `GET {hub}/public/org-plane`; it no
// longer issues tokens or device credentials itself. The CLI then runs the plane's device flow
// (RFC 8628 for the code and the polling, but the approved poll answers with a long-lived
// `device_credential`, NOT a token), and every later command exchanges that credential at
// `POST {plane}/api/token/device` for a five-minute token whose audience is the hub.
//
// A hub that answers 404 (older than the route) or `{ "issuer": null }` keeps the hub's own
// sign-in, unchanged. No environment variable chooses between them: the hub knows.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Plane is the organization plane a hub defers to, as GET {hub}/public/org-plane names it.
type Plane struct {
	Issuer   string `json:"issuer"`
	URL      string `json:"url"`
	Audience string `json:"audience"`
}

// DeviceCode is the RFC 8628 device authorization response.
type DeviceCode struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// The RFC 8628 §3.5 poll answers, as errors. Pending and slow_down are consumed by WaitForDevice;
// the other two end the wait.
var (
	ErrAuthorizationPending = errors.New("authorization pending")
	ErrSlowDown             = errors.New("slow down")
	ErrAccessDenied         = errors.New("the sign-in was denied")
	ErrDeviceCodeExpired    = errors.New("the sign-in code expired; run fleet login again")
)

var planeHTTP = &http.Client{Timeout: 30 * time.Second}
var devCredential = regexp.MustCompile(`^(dev_[0-9a-f]{20}):([A-Za-z0-9_-]{43})$`)

func postJSON(url string, body any, bearer string) (*http.Response, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return planeHTTP.Do(req)
}

// ValidatePlaneURL accepts https, or plain http only for a loopback host — the hub's own rule for
// ORG_PLANE_URL. Anything else (http to a real host, file:, a bare host) is refused: the plane
// URL receives this machine's device secret (security review finding 6).
func ValidatePlaneURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("the account service url %q is not an absolute URL", raw)
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && isLoopback(u.Hostname()):
	default:
		return nil, fmt.Errorf("the account service url %q must be https (plain http only for a loopback host)", raw)
	}
	return u, nil
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// checkVerificationPage requires the page a human is sent to (and that openBrowser opens) to be
// on the plane's own origin — same scheme, host and port — so a hostile answer cannot open an
// arbitrary URL or a local file on this machine.
func checkVerificationPage(p Plane, page string) error {
	if page == "" {
		return nil
	}
	plane, err := ValidatePlaneURL(p.URL)
	if err != nil {
		return err
	}
	u, err := url.Parse(page)
	if err != nil || u.Scheme != plane.Scheme || u.Host != plane.Host {
		return fmt.Errorf("the account service sent a sign-in page %q that is not on %s; refusing to open it", page, p.URL)
	}
	return nil
}

// DiscoverPlane asks the hub. nil, nil means the hub issues its own tokens (legacy).
func DiscoverPlane(hub string) (*Plane, error) {
	res, err := planeHTTP.Get(strings.TrimRight(hub, "/") + "/public/org-plane")
	if err != nil {
		return nil, fmt.Errorf("could not reach %s: %w", hub, err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	var out struct {
		Issuer   *string `json:"issuer"`
		URL      string  `json:"url"`
		Audience string  `json:"audience"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode != 200 {
		return nil, fmt.Errorf("the hub's org-plane answer was unreadable (%d)", res.StatusCode)
	}
	if out.Issuer == nil || *out.Issuer == "" {
		return nil, nil
	}
	// An issuer with nowhere to reach it, or no audience to ask for, is a misconfigured hub.
	// Guessing a URL would send this machine's device secret to a host nobody named.
	if strings.TrimSpace(out.URL) == "" || strings.TrimSpace(out.Audience) == "" {
		return nil, fmt.Errorf("the hub names an account service (%s) but not its url and audience", *out.Issuer)
	}
	if _, err := ValidatePlaneURL(out.URL); err != nil {
		return nil, fmt.Errorf("the hub names an unusable account service: %w", err)
	}
	return &Plane{Issuer: *out.Issuer, URL: strings.TrimRight(out.URL, "/"), Audience: out.Audience}, nil
}

// StartDeviceFlow asks the plane for a device code and the page the human approves it at.
func StartDeviceFlow(p Plane) (DeviceCode, error) {
	if _, err := ValidatePlaneURL(p.URL); err != nil {
		return DeviceCode{}, err
	}
	res, err := postJSON(p.URL+"/api/auth/device/code", map[string]string{"client_id": ClientID, "scope": "openid"}, "")
	if err != nil {
		return DeviceCode{}, fmt.Errorf("could not reach the account service: %w", err)
	}
	defer res.Body.Close()
	var dc DeviceCode
	if err := json.NewDecoder(res.Body).Decode(&dc); err != nil || res.StatusCode != 200 || dc.DeviceCode == "" {
		return DeviceCode{}, fmt.Errorf("the account service refused to start a sign-in (%d)", res.StatusCode)
	}
	if err := checkVerificationPage(p, dc.VerificationURI); err != nil {
		return DeviceCode{}, err
	}
	if err := checkVerificationPage(p, dc.VerificationURIComplete); err != nil {
		return DeviceCode{}, err
	}
	return dc, nil
}

// PollDeviceToken polls once. The success body is NOT an RFC 8628 token response: it is
// { "device_credential": "dev_<20 hex>:<43 base64url>" } (contract §3.2).
func PollDeviceToken(p Plane, deviceCode string) (Device, error) {
	res, err := postJSON(p.URL+"/api/auth/device/token", map[string]string{
		"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
		"device_code": deviceCode,
		"client_id":   ClientID,
	}, "")
	if err != nil {
		return Device{}, fmt.Errorf("could not reach the account service: %w", err)
	}
	defer res.Body.Close()
	var out struct {
		DeviceCredential string `json:"device_credential"`
		Error            string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	switch out.Error {
	case "authorization_pending":
		return Device{}, ErrAuthorizationPending
	case "slow_down":
		return Device{}, ErrSlowDown
	case "access_denied":
		return Device{}, ErrAccessDenied
	case "expired_token":
		return Device{}, ErrDeviceCodeExpired
	}
	m := devCredential.FindStringSubmatch(out.DeviceCredential)
	if res.StatusCode != 200 || m == nil {
		return Device{}, fmt.Errorf("the account service's answer held no device credential (%d)", res.StatusCode)
	}
	return Device{ID: m[1], Secret: m[2], PlaneURL: p.URL, Issuer: p.Issuer, Audience: p.Audience}, nil
}

// WaitForDevice polls at the server's interval (RFC 8628 §3.5: +5s on slow_down) until approved,
// denied, or the code expires.
func WaitForDevice(p Plane, dc DeviceCode, sleep func(time.Duration)) (Device, error) {
	interval := time.Duration(dc.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	var waited time.Duration
	limit := time.Duration(dc.ExpiresIn) * time.Second
	if limit <= 0 {
		// RFC 8628 makes expires_in REQUIRED; a plane that omits it does not get an endless wait.
		limit = 15 * time.Minute
	}
	for waited < limit {
		sleep(interval)
		waited += interval
		d, err := PollDeviceToken(p, dc.DeviceCode)
		switch {
		case err == nil:
			return d, nil
		case errors.Is(err, ErrAuthorizationPending):
			continue
		case errors.Is(err, ErrSlowDown):
			interval += 5 * time.Second
			continue
		default:
			return Device{}, err
		}
	}
	return Device{}, ErrDeviceCodeExpired
}

// ExchangeAtPlane turns the stored device credential into a 5-minute access token for the hub.
func ExchangeAtPlane(d Device) (string, error) {
	// device.json is a file on disk; a PlaneURL edited to http (or written by an older build)
	// must not carry the secret in the clear.
	if _, err := ValidatePlaneURL(d.PlaneURL); err != nil {
		return "", err
	}
	res, err := postJSON(strings.TrimRight(d.PlaneURL, "/")+"/api/token/device", map[string]string{"audience": d.Audience}, d.ID+":"+d.Secret)
	if err != nil {
		return "", fmt.Errorf("could not reach the account service: %w", err)
	}
	defer res.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode != 200 || out.AccessToken == "" {
		return "", fmt.Errorf("the account service refused this device credential (%d)", res.StatusCode)
	}
	return out.AccessToken, nil
}
