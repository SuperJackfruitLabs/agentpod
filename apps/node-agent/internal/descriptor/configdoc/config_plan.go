package configdoc

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
)

// maxDiff bounds a plan's rendered diff, the same bound hermeslive's plugin
// operations use (hermeslive.OperationLimit's neighbour, maxDiff, is not
// exported, so this is the same value kept in step with it by hand rather
// than a second diff algorithm).
const maxDiff = 16 << 10

// ConfigDigestOf hashes everything a plan carries except the three fields
// that must not change what the digest means for an otherwise-unchanged
// document:
//
//   - PlanDigest itself (it cannot hash itself).
//   - CreatedAt, a timestamp that would make two plans of the SAME document
//     digest differently depending only on when each was drawn.
//   - OperationID, which names the review request, not the document.
//
// Task 5 re-derives a plan and compares digests to detect a stale one
// (PLAN_STALE); if CreatedAt or OperationID leaked into the hash, every
// re-derivation of an untouched document would look stale. See
// TestPlanIsDeterministicForTheSameDocument, and the precedent this follows,
// hermeslive's digestOf (internal/hermeslive/operation.go).
func ConfigDigestOf(p descriptor.ConfigPlan) string {
	p.PlanDigest = ""
	p.CreatedAt = ""
	p.OperationID = ""
	data, _ := json.Marshal(p)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Sha256Hex is the hex-encoded SHA-256 of data, used for ConfigPlan's
// BeforeSHA256 and ConfigReceipt's AfterSHA256.
func Sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// BuildDiff renders before/after the way hermeslive's plugin operations do
// (hermeslive.DiffLines), truncated at the same maxDiff bound.
func BuildDiff(before, after []byte) (diff string, truncated bool) {
	diff = hermeslive.DiffLines(string(before), string(after))
	if len(diff) > maxDiff {
		return diff[:maxDiff], true
	}
	return diff, false
}

// IsCredentialPath reports whether path names a file this system must never
// read or write as a plain setting document: a basename of "auth.json" or
// ".env", or any path segment literally named "credentials".
//
// It is a plain function, not a method, and is tested directly
// (TestPlanRefusesACredentialPath) rather than through PlanConfig: every
// Hermes setting registered today resolves to config.yaml, so PlanConfig can
// never reach this branch through the real registry, and adding a fake
// credential-resolving entry to that registry just to exercise the check
// would change what the registry can do. The check still runs first, before
// anything is read, so a future setting that DOES resolve elsewhere is
// refused rather than opened.
func IsCredentialPath(path string) bool {
	base := filepath.Base(path)
	if base == "auth.json" || base == ".env" {
		return true
	}
	for _, seg := range strings.Split(filepath.ToSlash(path), "/") {
		if seg == "credentials" {
			return true
		}
	}
	return false
}

// ToStringList reports v as a []string, accepting either a native Go
// []string (how every test in this package declares a value) or []any whose
// elements are all strings (how a value survives a JSON round trip). Any
// other shape is not a list of strings this editor can append.
func ToStringList(v any) ([]string, bool) {
	switch t := v.(type) {
	case []string:
		return t, true
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			s, ok := item.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	default:
		return nil, false
	}
}
