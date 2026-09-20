package fleetcred

// The device credential — what makes `fleet` usable for sustained work.
//
// A hub token lives five minutes. An agent re-mints by exchanging the credential it already
// holds; a browser re-mints silently from its session cookie. A human at a terminal held
// NEITHER, so every lapse cost a browser, a person and a click — four times in one session on
// 2026-09-20, twice landing between minting a token and using it.
//
// `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`, accepted
// 2026-09-20, option C: `login` writes a long-lived credential bound to THIS device, and every
// command exchanges it for a five-minute token. The same mechanism an agent already uses, with
// a device credential playing the station credential's role.
//
// **This is a second long-lived secret on disk, and that was the cost the record conceded.**
// It is written 0600 inside a 0700 directory, beside the token and nowhere near the node's
// config — the rule that neither binary reads the other's credential is unchanged and still
// pinned by a test. What bounds it: ninety days that slide on use, revocation from two
// surfaces, and a hub that marks the minted token `amr: ["device"]` so superpipeline refuses to
// grow a thirty-day session from one.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrNoDevice is returned when this machine holds no device credential. Callers fall back to
// whatever they did before it existed, which is to tell the operator to run `fleet login`.
var ErrNoDevice = errors.New("no device credential")

// Device is the credential this machine exchanges, and the hub it belongs to.
type Device struct {
	ID     string `json:"id"`
	Secret string `json:"secret"`
	Hub    string `json:"hub,omitempty"`
	Name   string `json:"name,omitempty"`
}

// DevicePath is where `fleet login` stores the device credential.
//
// A separate file from `token.json` on purpose: they have different lifetimes and different
// blast radii. `logout` removes both; a corrupted token cache can be deleted without losing the
// credential that would silently replace it.
func DevicePath() string {
	d, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(d, "agentpod", "device.json")
}

// SaveDevice writes the credential 0600 inside a 0700 directory — the same posture as the token
// and the node config.
func SaveDevice(d Device) error {
	p := DevicePath()
	if p == "" {
		return errors.New("cannot determine a config directory to store the device credential in")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

// LoadDevice reads the stored credential, or ErrNoDevice.
//
// A file that exists but is unreadable, malformed, or missing either half is ErrNoDevice rather
// than an error: the operator's next move is `fleet login` in every one of those cases, and a
// parse error printed at them names a file they did not write.
func LoadDevice() (Device, error) {
	p := DevicePath()
	if p == "" {
		return Device{}, ErrNoDevice
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return Device{}, ErrNoDevice
	}
	var d Device
	if err := json.Unmarshal(b, &d); err != nil {
		return Device{}, ErrNoDevice
	}
	if strings.TrimSpace(d.ID) == "" || strings.TrimSpace(d.Secret) == "" {
		return Device{}, ErrNoDevice
	}
	return d, nil
}

// ForgetDevice removes the stored credential. Absent is success.
func ForgetDevice() error {
	p := DevicePath()
	if p == "" {
		return nil
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ExchangeDevice trades the device credential for a five-minute token.
//
// `Authorization: Bearer <deviceId>:<secret>` — the same scheme the node uses for
// `<nodeId>:<nodeSecret>`, so there is one shape for every long-lived credential the hub takes.
//
// The hub answers 401 for every refusal without distinguishing them (unknown, wrong secret,
// revoked, expired), and this does not try to guess which: a caller that reported "your device
// was revoked" on a 401 would be inventing a fact from a status code chosen precisely so it
// could not be read that way.
func ExchangeDevice(hub string, d Device) (string, error) {
	req, err := http.NewRequest("POST", strings.TrimRight(hub, "/")+"/api/auth/devices/token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+d.ID+":"+d.Secret)

	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach %s: %w", hub, err)
	}
	defer res.Body.Close()

	var out struct {
		Token string `json:"token"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("the hub's answer was not JSON (%d)", res.StatusCode)
	}
	if res.StatusCode != 200 || out.Token == "" {
		return "", fmt.Errorf("the hub refused this device credential (%d)", res.StatusCode)
	}
	return out.Token, nil
}

// CreateDevice asks the hub for a device credential, authenticated by a token just obtained
// through the browser flow.
//
// Called once, at the end of `fleet login`. The hub refuses this when the presented token was
// itself minted from a device — so a stolen credential cannot mint a replacement that outlives
// the revocation of the one that was stolen.
func CreateDevice(hub, token, name string) (Device, error) {
	body, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		return Device{}, err
	}
	req, err := http.NewRequest("POST", strings.TrimRight(hub, "/")+"/api/auth/devices", bytes.NewReader(body))
	if err != nil {
		return Device{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return Device{}, fmt.Errorf("could not reach %s: %w", hub, err)
	}
	defer res.Body.Close()

	var out struct {
		ID     string `json:"id"`
		Secret string `json:"secret"`
		Name   string `json:"name"`
		Error  string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return Device{}, fmt.Errorf("the hub's answer was not JSON (%d)", res.StatusCode)
	}
	if res.StatusCode != 201 || out.ID == "" || out.Secret == "" {
		if out.Error != "" {
			return Device{}, fmt.Errorf("the hub declined to create a device credential: %s", out.Error)
		}
		return Device{}, fmt.Errorf("the hub declined to create a device credential (%d)", res.StatusCode)
	}
	return Device{ID: out.ID, Secret: out.Secret, Hub: hub, Name: out.Name}, nil
}

// Resolve is what every fleet command should call: a usable token, or ErrNoCredential.
//
// The order matters and each step earns its place:
//
//  1. `$AGENTPOD_TOKEN` — unchanged, and still first, so a CI job or an agent harness can supply
//     a token without a file and without this ever reaching the network.
//  2. A cached token that has not expired. The common case, and it costs nothing.
//  3. **The device credential, exchanged.** The step that removes the browser from the loop. The
//     fresh token is cached so the next command takes path 2.
//  4. ErrNoCredential, whose caller says `fleet login` — unchanged.
//
// Kept separate from `Load`, which stays purely local. `Load` is what the "never read the node's
// credential" test drives, and giving it a network call would make that test's subject ambiguous.
func Resolve(hub string) (Credential, error) {
	if t := strings.TrimSpace(os.Getenv(EnvToken)); t != "" {
		return Credential{Token: t, Source: "env:" + EnvToken}, nil
	}

	if c, err := Load(); err == nil {
		if claims, err := Inspect(c.Token); err != nil || !claims.Expired() {
			return c, nil
		}
	}

	d, err := LoadDevice()
	if err != nil {
		return Credential{}, ErrNoCredential
	}
	// The credential names the hub it was issued by. Exchanging it against a different one would
	// send this machine's secret to a host that never issued it.
	if d.Hub != "" && strings.TrimRight(d.Hub, "/") != strings.TrimRight(hub, "/") {
		return Credential{}, ErrNoCredential
	}

	token, err := ExchangeDevice(hub, d)
	if err != nil {
		return Credential{}, ErrNoCredential
	}
	// Best effort: a token that cannot be cached still works for this command.
	_ = Save(token, hub)
	return Credential{Token: token, Source: DevicePath()}, nil
}

// RevokeDeviceByID revokes a device the caller owns, authenticated by a hub token.
//
// The hub scopes the revocation to the caller's own devices in its WHERE clause, so a device
// belonging to somebody else and one that does not exist are the same 404 — this cannot be used
// to enumerate.
func RevokeDeviceByID(hub, token, deviceID string) error {
	req, err := http.NewRequest("DELETE", strings.TrimRight(hub, "/")+"/api/auth/devices/"+deviceID, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("could not reach %s: %w", hub, err)
	}
	defer res.Body.Close()

	if res.StatusCode == 404 {
		return fmt.Errorf("no live device %s", deviceID)
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("the hub refused to revoke %s (%d)", deviceID, res.StatusCode)
	}
	return nil
}

// RevokeDevice revokes THIS machine's credential, authenticating with the credential itself.
//
// Used by `logout`, and it exchanges first on purpose. The alternative — reusing whatever token
// happens to be cached — fails in the exact case that matters: an operator signing out after not
// touching this machine for a week has an expired token and every reason to want the credential
// gone. Exchanging turns "I hold this secret" into the authority to revoke it, which is a thing
// the holder of a secret should always be able to do.
func RevokeDevice(hub string, d Device) error {
	token, err := ExchangeDevice(hub, d)
	if err != nil {
		return err
	}
	return RevokeDeviceByID(hub, token, d.ID)
}
