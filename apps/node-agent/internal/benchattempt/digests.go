package benchattempt

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// These retain the private model's existing raw/Go-JSON meanings. They are not
// the proposed settlement owner's canonical request or receipt algorithm.
func RawSHA256(raw []byte) string      { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func PlanIdentitySHA256(p Plan) string { raw, _ := json.Marshal(p.Identity); return RawSHA256(raw) }
func PlanSHA256(p Plan) string         { raw, _ := json.Marshal(p); return RawSHA256(raw) }
func SourceIdentitySHA256(s SourceSpec) string {
	raw, _ := json.Marshal(s.Identity)
	return RawSHA256(raw)
}
func SourceSpecSHA256(s SourceSpec) string       { raw, _ := json.Marshal(s); return RawSHA256(raw) }
func SourceBindingSHA256(b SourceBinding) string { raw, _ := json.Marshal(b); return RawSHA256(raw) }
