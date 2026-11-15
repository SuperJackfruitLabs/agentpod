package benchattempt

import "errors"

var (
	ErrInvalid  = errors.New("invalid private dispatch data")
	ErrPending  = errors.New("dispatch may have started; reconciliation required")
	ErrOwner    = errors.New("dispatch owner is not current")
	ErrConflict = errors.New("immutable dispatch data conflicts")
	ErrVerify   = errors.New("dispatch observation not verified")
)
