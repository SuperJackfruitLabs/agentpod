package benchattempt

import "regexp"

var cleanupDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var cleanupRequestID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)

func ValidCancellations(records []Cancellation) bool {
	if len(records) > 256 {
		return false
	}
	seen := map[string]bool{}
	for _, c := range records {
		if !cleanupDigest.MatchString(c.IdentitySHA256) || !cleanupDigest.MatchString(c.SourceSHA256) || seen[c.IdentitySHA256] || len(c.Observations) > 32 || len(c.Exchanges) > 32 {
			return false
		}
		seen[c.IdentitySHA256] = true
		for _, o := range c.Observations {
			if !ValidCleanupObservation(o) {
				return false
			}
		}
		for _, e := range c.Exchanges {
			if !ValidCleanupExchange(e) {
				return false
			}
		}
	}
	return true
}
func ValidCleanupExchange(e CleanupExchange) bool {
	return (e.Operation == "cancel" || e.Operation == "receipt_lookup") && cleanupRequestID.MatchString(e.TargetRequestID) && cleanupDigest.MatchString(e.TargetDigest) && cleanupDigest.MatchString(e.RequestSHA256) && ((e.ResponseSHA256 == "" && e.HTTPStatus == 0) || (cleanupDigest.MatchString(e.ResponseSHA256) && e.HTTPStatus >= 100 && e.HTTPStatus <= 599))
}
func ValidCleanupObservation(o CleanupObservation) bool {
	if !cleanupDigest.MatchString(o.TargetDigest) {
		return false
	}
	if o.Operation == "cancel" {
		return cleanupRequestID.MatchString(o.TargetRequestID) && (o.State == "cancel_requested" || o.State == "cancelled" || o.State == "already_completed" || o.State == "uncertain")
	}
	return o.Operation == "stop" && o.TargetRequestID == "" && (o.State == "stop_observed" || o.State == "uncertain")
}
func FindCancellation(records []Cancellation, identity, source string) (*Cancellation, error) {
	for i := range records {
		c := &records[i]
		if c.IdentitySHA256 == identity {
			if c.SourceSHA256 != source {
				return nil, ErrConflict
			}
			return c, nil
		}
	}
	return nil, ErrOwner
}
