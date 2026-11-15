package benchcoordinatorwire

import (
	"crypto/sha256"
	"encoding/hex"
)

const CurrentVersion = "agentpod.bench-coordinator-current.v1"
const Verb = "bench.coordinator"

// CurrentRequest names an already retained attempt. Neither a request nor a
// digest creates authority; the authenticated Hub must re-read its actual state.
type CurrentRequest struct {
	Version       string   `json:"version"`
	Phase         string   `json:"phase"`
	Nonce         string   `json:"nonce"`
	Identity      Identity `json:"identity"`
	Target        Target   `json:"target"`
	ProfileID     string   `json:"profile_id"`
	BindingSHA256 string   `json:"binding_sha256,omitempty"`
	SourceDigest  string   `json:"source_digest,omitempty"`
}

type CurrentResponse struct {
	Version       string `json:"version"`
	Nonce         string `json:"nonce"`
	RequestSHA256 string `json:"request_sha256"`
	IssuedAtMs    uint64 `json:"issued_at_ms"`
	ExpiresAtMs   uint64 `json:"expires_at_ms"`
	Decision      string `json:"decision"`
	Code          string `json:"code,omitempty"`
}

func ParseCurrentRequest(raw []byte) (CurrentRequest, error) {
	var r CurrentRequest
	if decode(raw, MaxRequest, &r) != nil || r.Version != CurrentVersion ||
		!one(r.Phase, "prepare", "execute", "observe") || !bidPattern.MatchString(r.Nonce) ||
		!matched(r.Identity, r.Target) || !ids(r.ProfileID) ||
		r.BindingSHA256 != "" && !hashes(r.BindingSHA256) || r.SourceDigest != "" && !hashes(r.SourceDigest) ||
		r.SourceDigest != "" && r.BindingSHA256 == "" ||
		r.Phase == "execute" && (r.BindingSHA256 == "" || r.SourceDigest == "") {
		return CurrentRequest{}, ErrInvalid
	}
	return r, nil
}

// ParseCurrentResponse binds a short-lived reply to this exact random nonce and
// exact raw request. Replayed, future, expired or malformed decisions fail shut.
// The caller still must refuse a well-formed decision="refused".
func ParseCurrentResponse(raw, requestRaw []byte, nowMs int64) (CurrentResponse, error) {
	request, err := ParseCurrentRequest(requestRaw)
	var r CurrentResponse
	h := sha256.Sum256(requestRaw)
	if err != nil || nowMs < 0 || decode(raw, 4096, &r) != nil || r.Version != CurrentVersion ||
		r.Nonce != request.Nonce || r.RequestSHA256 != hex.EncodeToString(h[:]) ||
		r.IssuedAtMs > 9007199254740991 || r.ExpiresAtMs > 9007199254740991 ||
		r.ExpiresAtMs <= r.IssuedAtMs || r.ExpiresAtMs-r.IssuedAtMs > 5000 ||
		r.IssuedAtMs > uint64(nowMs) || r.ExpiresAtMs <= uint64(nowMs) ||
		!one(r.Decision, "current", "refused") || r.Decision == "current" && r.Code != "" ||
		r.Decision == "refused" && !one(r.Code, "unauthorized", "stale_owner", "unavailable", "pending", "invalid") {
		return CurrentResponse{}, ErrInvalid
	}
	return r, nil
}
