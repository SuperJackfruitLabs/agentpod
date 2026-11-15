package benchattempt

import (
	"errors"
	"strings"
	"testing"
)

func TestCancellationIdentityIsExactAndClosed(t *testing.T) {
	valid := Cancellation{IdentitySHA256: strings.Repeat("a", 64), SourceSHA256: strings.Repeat("b", 64), Observations: []CleanupObservation{{Operation: "cancel", TargetRequestID: "source-lease", TargetDigest: strings.Repeat("c", 64), State: "cancel_requested"}}}
	if !ValidCancellations([]Cancellation{valid}) {
		t.Fatal("valid private marker refused")
	}
	for _, change := range []func(*Cancellation){
		func(c *Cancellation) { c.IdentitySHA256 = strings.Repeat("A", 64) },
		func(c *Cancellation) { c.SourceSHA256 = "" },
		func(c *Cancellation) { c.Observations[0].State = "released" },
		func(c *Cancellation) { c.Observations[0].TargetRequestID = "wrong.id" },
		func(c *Cancellation) { c.Observations[0].Operation = "stop_admin" },
		func(c *Cancellation) { c.Observations[0].TargetDigest = "not-a-digest" },
	} {
		c := valid
		c.Observations = append([]CleanupObservation(nil), valid.Observations...)
		change(&c)
		if ValidCancellations([]Cancellation{c}) {
			t.Fatal("malformed cancellation granted meaning", c)
		}
	}
	if ValidCancellations([]Cancellation{valid, valid}) {
		t.Fatal("duplicate attempt accepted")
	}
	if _, e := FindCancellation([]Cancellation{valid}, valid.IdentitySHA256, strings.Repeat("d", 64)); !errors.Is(e, ErrConflict) {
		t.Fatal("changed source rebound existing intent", e)
	}
	if _, e := FindCancellation([]Cancellation{valid}, strings.Repeat("d", 64), valid.SourceSHA256); !errors.Is(e, ErrOwner) {
		t.Fatal("unknown attempt adopted old intent", e)
	}
	if ValidCleanupObservation(CleanupObservation{Operation: "stop", TargetRequestID: "old-run", TargetDigest: strings.Repeat("e", 64), State: "stop_observed"}) {
		t.Fatal("token stop confused with operation cancel")
	}
}
