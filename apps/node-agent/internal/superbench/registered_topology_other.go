//go:build !unix

package superbench

import "context"

func inspectRegistered(context.Context, RegisteredCapsule) error { return ErrRegisteredLayout }
