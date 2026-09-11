// Package fleetcred resolves the credential `apn fleet` acts with.
//
// # Why this is a package and not three lines in main
//
// `apn` has two modes, and the boundary between them is the CREDENTIAL, not the verb list.
// `apn node` acts as this machine, with `<nodeId>:<nodeSecret>` from the node's own config.
// `apn fleet` acts as a principal — a person, or an agent — with a hub-issued token.
//
// The rule that makes it safe to ship fleet verbs in the binary installed on every station:
// **neither mode may ever read the other's credential.** A fleet command with no token fails and
// says how to get one. It must never fall back to the node secret, because a node secret is a
// MACHINE identity, and letting it act on the fleet would be the CLI inventing an escalation no
// hub guard asked for.
//
// The two live in different directories for the same reason — `agentpod-node/` and `agentpod/` —
// so neither can be reached by a path mistake, and an operator can delete one without disturbing
// the other.
//
// The consequence worth stating plainly: the fleet verbs are present on every station and
// **useless without a token the node does not have**. Authority stays where it already is, in the
// hub's own guards.
package fleetcred

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrNoCredential is returned when no fleet token can be found. Callers print its message and
// exit non-zero; they must NOT retry with anything else.
var ErrNoCredential = errors.New("no fleet credential")

// EnvToken is read first, so a CI job or an agent harness can supply a token without a file.
const EnvToken = "AGENTPOD_TOKEN"

// EnvHub overrides the hub a fleet command talks to.
const EnvHub = "AGENTPOD_HUB"

// Credential is a resolved fleet token and where it came from, so an error message can name the
// thing the operator has to change.
type Credential struct {
	Token string
	// Source is "env" or the file path. Never a node config path — see the package comment.
	Source string
}

// Path is where `apn fleet login` stores its token.
//
// Deliberately NOT under `agentpod-node/`. A separate directory is what stops a future edit from
// reaching the node's secret with a relative path, and it lets an operator remove one credential
// without touching the other.
func Path() string {
	d, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(d, "agentpod", "token.json")
}

type stored struct {
	Token string `json:"token"`
	Hub   string `json:"hub,omitempty"`
}

// Load resolves the fleet credential: the environment first, then the login file.
//
// Returns ErrNoCredential when neither holds one. It does not look at the node's config, and a
// test asserts that even when a node config exists beside it.
func Load() (Credential, error) {
	if t := strings.TrimSpace(os.Getenv(EnvToken)); t != "" {
		return Credential{Token: t, Source: "env:" + EnvToken}, nil
	}
	p := Path()
	if p == "" {
		return Credential{}, ErrNoCredential
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return Credential{}, ErrNoCredential
	}
	var s stored
	if err := json.Unmarshal(b, &s); err != nil || strings.TrimSpace(s.Token) == "" {
		return Credential{}, ErrNoCredential
	}
	return Credential{Token: s.Token, Source: p}, nil
}

// Save writes the token for later `apn fleet` calls, 0600 inside a 0700 directory — the same
// posture the node config is written with.
func Save(token, hub string) error {
	p := Path()
	if p == "" {
		return errors.New("cannot determine a config directory to store the token in")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(stored{Token: token, Hub: hub}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

// Forget removes the stored token. Absent is success: `logout` twice is not an error.
func Forget() error {
	p := Path()
	if p == "" {
		return nil
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Claims is the little a CLI needs from a token it holds.
//
// Read WITHOUT verifying the signature, and that is correct here: this is not an authorization
// decision, it is `whoami` telling an operator what they are carrying. The hub verifies; the CLI
// never does, because a client that pre-empts a server's decision is a client that will one day
// disagree with it.
type Claims struct {
	Subject       string
	PrincipalKind string
	Expiry        time.Time
}

// Expired reports whether the token is past its `exp`. A zero expiry is treated as not expired —
// absence of a claim is not evidence of staleness, and the hub is the authority either way.
func (c Claims) Expired() bool {
	return !c.Expiry.IsZero() && time.Now().After(c.Expiry)
}

// Inspect decodes a JWT's payload. It does not and must not verify.
func Inspect(token string) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, fmt.Errorf("not a JWT: expected three dot-separated parts, found %d", len(parts))
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, fmt.Errorf("the token's payload is not valid base64url: %w", err)
	}
	var p struct {
		Sub           string `json:"sub"`
		PrincipalKind string `json:"principalKind"`
		Exp           int64  `json:"exp"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return Claims{}, fmt.Errorf("the token's payload is not JSON: %w", err)
	}
	c := Claims{Subject: p.Sub, PrincipalKind: p.PrincipalKind}
	if p.Exp > 0 {
		c.Expiry = time.Unix(p.Exp, 0)
	}
	return c, nil
}
