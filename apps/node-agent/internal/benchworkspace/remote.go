package benchworkspace

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Remote access to a bench: benchd issues a short-lived SSH writer certificate
// for the lease the caller holds, over the same local socket as every other
// route. The contract is PROPOSED and vendored from treaty (testdata/source.json).
const (
	PathRemoteCredentials = remoteRoot + "/credentials"
	PathRemoteStatus      = remoteRoot + "/status"
	RemoteVersion         = "superbench.remote.v1"

	// MaxRemoteBody bounds both the request and the reply.
	MaxRemoteBody = 16 << 10

	remoteCertOp       = "writer_certificate"
	remoteStatusOp     = "remote_status"
	remoteRoot         = "/v2/remote"
	maxRemotePublicKey = 8192
	maxSafeGeneration  = 1<<53 - 1
)

// ErrNoRemoteExecution means benchd lists no live remote execution for the key.
var ErrNoRemoteExecution = errors.New("no live remote execution for the workspace")

var (
	remoteTokenPattern   = regexp.MustCompile(`^[a-f0-9]{32}$`)
	remoteUserPattern    = regexp.MustCompile(`^b-[a-f0-9]{32}$`)
	remoteAddressPattern = regexp.MustCompile(`^([0-9]{1,3}(\.[0-9]{1,3}){3}|\[[0-9A-Fa-f:.]+\]):[0-9]{1,5}$`)
	remoteTimePattern    = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
	remoteCertPattern    = regexp.MustCompile(`^(ssh-ed25519|ecdsa-sha2-nistp256)-cert-v01@openssh\.com `)
)

// RemoteCredentialRequest asks for a writer certificate for PublicKey on the
// lease LeaseToken owns. The token is a capability: String and every error hide it.
type RemoteCredentialRequest struct{ Key, LeaseToken, PublicKey string }

func (r RemoteCredentialRequest) String() string {
	return "writer_certificate request for " + r.Key
}

// GoString keeps %#v from printing the token as well.
func (r RemoteCredentialRequest) GoString() string { return r.String() }

func (r RemoteCredentialRequest) valid() bool {
	return keyPattern.MatchString(r.Key) && remoteTokenPattern.MatchString(r.LeaseToken) &&
		r.PublicKey != "" && len(r.PublicKey) <= maxRemotePublicKey && utf8.ValidString(r.PublicKey) &&
		!strings.ContainsFunc(r.PublicKey, func(c rune) bool { return c < 0x20 || c == 0x7f })
}

// Bytes is the exact request body, or ErrInvalid.
func (r RemoteCredentialRequest) Bytes() ([]byte, error) {
	if !r.valid() {
		return nil, ErrInvalid
	}
	return json.Marshal(struct {
		Version    string `json:"version"`
		Operation  string `json:"operation"`
		Key        string `json:"key"`
		LeaseToken string `json:"lease_token"`
		PublicKey  string `json:"public_key"`
	}{RemoteVersion, remoteCertOp, r.Key, r.LeaseToken, r.PublicKey})
}

// RemoteCredential is a signed writer certificate (public) and what a client
// needs to use it. It never carries the lease token.
type RemoteCredential struct {
	Certificate, User, Address, HostKey, HostKeyFingerprint, LeaseID string
	Generation                                                       uint64
	ValidBefore                                                      time.Time
	WorkingDirectory                                                 string
}

// remoteEnvelope reads a reply's envelope. Unknown fields are ignored (the
// client tolerates added fields); a missing or invalid required field is not.
// A refusal comes back as *Failure with the reply's static code only.
func remoteEnvelope(raw []byte, status int, operation string) (json.RawMessage, error) {
	if len(raw) > MaxRemoteBody || !utf8.Valid(raw) || !scalarEscapes(raw) || !strictJSON(raw) {
		return nil, ErrInvalid
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(raw, &top) != nil || top == nil {
		return nil, ErrInvalid
	}
	var version, op string
	var ok bool
	if remoteField(top, "version", &version) != nil || remoteField(top, "operation", &op) != nil || remoteField(top, "ok", &ok) != nil ||
		version != RemoteVersion || op != operation {
		return nil, ErrInvalid
	}
	result, hasResult := top["result"]
	errRaw, hasError := top["error"]
	if ok {
		if status != 200 || !hasResult || hasError {
			return nil, ErrInvalid
		}
		return result, nil
	}
	if hasResult || !hasError {
		return nil, ErrInvalid
	}
	var e map[string]json.RawMessage
	var code, message string
	if json.Unmarshal(errRaw, &e) != nil || e == nil || remoteField(e, "code", &code) != nil || remoteField(e, "message", &message) != nil || message == "" {
		return nil, ErrInvalid
	}
	want := map[string]int{"invalid_request": 400, "forbidden": 403, "not_found": 404, "conflict": 409, "unavailable": 503}[code]
	if want == 0 || want != status {
		return nil, ErrInvalid
	}
	return nil, &Failure{Code: code}
}

func remoteField(m map[string]json.RawMessage, name string, into any) error {
	raw, found := m[name]
	if !found {
		return ErrInvalid
	}
	if json.Unmarshal(raw, into) != nil {
		return ErrInvalid
	}
	return nil
}

// ParseRemoteCredentialResponse validates a /v2/remote/credentials reply
// against its HTTP status. A refusal is a *Failure; anything malformed is ErrInvalid.
func ParseRemoteCredentialResponse(raw []byte, status int) (RemoteCredential, error) {
	var zero RemoteCredential
	result, err := remoteEnvelope(raw, status, remoteCertOp)
	if err != nil {
		return zero, err
	}
	var f map[string]json.RawMessage
	if json.Unmarshal(result, &f) != nil || f == nil {
		return zero, ErrInvalid
	}
	var c RemoteCredential
	var validBefore string
	for name, into := range map[string]*string{
		"certificate": &c.Certificate, "user": &c.User, "address": &c.Address, "host_key": &c.HostKey,
		"host_key_fingerprint": &c.HostKeyFingerprint, "lease_id": &c.LeaseID, "valid_before": &validBefore,
		"working_directory": &c.WorkingDirectory,
	} {
		if remoteField(f, name, into) != nil {
			return zero, ErrInvalid
		}
	}
	generation, found := f["generation"]
	if !found {
		return zero, ErrInvalid
	}
	c.Generation, err = strconv.ParseUint(string(generation), 10, 64)
	if err != nil || c.Generation < 1 || c.Generation > maxSafeGeneration {
		return zero, ErrInvalid
	}
	c.ValidBefore, err = time.Parse(time.RFC3339Nano, validBefore)
	if err != nil || !remoteTimePattern.MatchString(validBefore) ||
		!remoteCertPattern.MatchString(c.Certificate) || !remoteUserPattern.MatchString(c.User) ||
		!remoteAddressPattern.MatchString(c.Address) || c.HostKey == "" || !strings.HasPrefix(c.HostKeyFingerprint, "SHA256:") ||
		!idPattern.MatchString(c.LeaseID) || !strings.HasPrefix(c.WorkingDirectory, "/") ||
		strings.ContainsFunc(c.WorkingDirectory, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return zero, ErrInvalid
	}
	return c, nil
}

// remoteFailure maps a transport or framing problem to the one static code.
func remoteFailure(err error) error {
	if errors.Is(err, ErrInvalid) {
		return err
	}
	return &Failure{Code: "unavailable", Uncertain: true}
}

func (c *Client) remotePost(ctx context.Context, path string, body []byte) (int, []byte, error) {
	status, raw, err := c.Post(ctx, path, "application/json", body, MaxRemoteBody)
	if err != nil {
		return 0, nil, remoteFailure(err)
	}
	return status, raw, nil
}

// RemoteCredential asks benchd for a writer certificate once. It never retries.
func (c *Client) RemoteCredential(ctx context.Context, r RemoteCredentialRequest) (RemoteCredential, error) {
	body, err := r.Bytes()
	if err != nil {
		return RemoteCredential{}, err
	}
	status, raw, err := c.remotePost(ctx, PathRemoteCredentials, body)
	if err != nil {
		return RemoteCredential{}, err
	}
	return ParseRemoteCredentialResponse(raw, status)
}

// RemoteExecutionID returns the one live remote execution benchd lists for key.
func (c *Client) RemoteExecutionID(ctx context.Context, key string) (string, error) {
	if !keyPattern.MatchString(key) {
		return "", ErrInvalid
	}
	body, err := json.Marshal(map[string]string{"version": RemoteVersion, "operation": remoteStatusOp, "key": key})
	if err != nil {
		return "", ErrInvalid
	}
	status, raw, err := c.remotePost(ctx, PathRemoteStatus, body)
	if err != nil {
		return "", err
	}
	result, err := remoteEnvelope(raw, status, remoteStatusOp)
	if err != nil {
		return "", err
	}
	var s struct {
		Remote *[]map[string]json.RawMessage `json:"remote"`
	}
	if json.Unmarshal(result, &s) != nil || s.Remote == nil {
		return "", ErrInvalid
	}
	found := ""
	for _, e := range *s.Remote {
		var k, id string
		if remoteField(e, "key", &k) != nil || remoteField(e, "execution_id", &id) != nil || id == "" || len(id) > 128 {
			return "", ErrInvalid
		}
		if k != key {
			continue
		}
		if found != "" {
			return "", ErrInvalid
		}
		found = id
	}
	if found == "" {
		return "", ErrNoRemoteExecution
	}
	return found, nil
}
