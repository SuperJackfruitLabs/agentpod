package forgeapi

import "context"

// Unavailable answers every forge.api verb with `stk-unavailable`. The node uses it when forge API
// access cannot be configured (a bad port range, say): a mistake in this one setting must not stop
// the node, which has much else to do, so it logs the cause once, does not advertise `forge.api`,
// and lets the verbs say why.
type Unavailable struct{ Cause error }

func (u Unavailable) err() error {
	cause := "unknown"
	if u.Cause != nil {
		cause = clean(u.Cause.Error())
	}
	return codedf("stk-unavailable", "forge API access is disabled on this node: %s", cause)
}

func (u Unavailable) Deliver(context.Context, DeliverParams) (DeliverAck, error) {
	return DeliverAck{}, u.err()
}

// Policy answers in the policy ack's own shape (the hub reads its error field).
func (u Unavailable) Policy(context.Context, PolicyParams) (PolicyAck, error) {
	return PolicyAck{OK: false, Error: u.err().Error()}, nil
}
func (u Unavailable) Verify(context.Context, VerifyParams) (VerifyAck, error) {
	return VerifyAck{}, u.err()
}
func (u Unavailable) Revoke(context.Context, RevokeParams) (RevokeAck, error) {
	return RevokeAck{}, u.err()
}
func (u Unavailable) Status(context.Context, StatusParams) (StatusAck, error) {
	return StatusAck{}, u.err()
}
