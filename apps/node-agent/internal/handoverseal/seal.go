// Package handoverseal seals a credential to a station's stk handover public
// key. The format is frozen by stk (supertoolkit docs/handover-v1.md) and
// pinned by packages/contract/fixtures/handover-v1.json. Nothing here logs or
// echoes its inputs, and errors never include the key or the material.
package handoverseal

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"golang.org/x/crypto/nacl/box"
)

const prefix = "stk-handover-v1:"

var alphabet = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// ParsePublicKey parses "stk-handover-v1:<base64url-nopad 32 bytes>".
func ParsePublicKey(s string) (*[32]byte, error) {
	if !strings.HasPrefix(s, prefix) {
		return nil, errors.New("handover public key must start with " + prefix)
	}
	body := strings.TrimPrefix(s, prefix)
	// Stricter than stk's own Go parser on purpose: Go's base64 decoder skips
	// CR/LF, so check the alphabet first. The TS sealer does the same.
	if !alphabet.MatchString(body) {
		return nil, errors.New("handover public key is not unpadded base64url")
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(body)
	if err != nil {
		return nil, errors.New("handover public key is not unpadded base64url")
	}
	if len(raw) != 32 {
		return nil, errors.New("handover public key must be 32 bytes")
	}
	var k [32]byte
	copy(k[:], raw)
	return &k, nil
}

// Seal returns "stk-handover-v1:<base64url-nopad sealed box>" of the JSON material.
func Seal(publicKey string, material map[string]string) (string, error) {
	key, err := ParsePublicKey(publicKey)
	if err != nil {
		return "", err
	}
	if len(material) == 0 {
		return "", errors.New("handover material is empty")
	}
	plain, err := json.Marshal(material)
	if err != nil {
		return "", errors.New("handover material could not be encoded")
	}
	sealed, err := box.SealAnonymous(nil, plain, key, rand.Reader)
	if err != nil {
		return "", errors.New("sealing failed")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(sealed), nil
}
