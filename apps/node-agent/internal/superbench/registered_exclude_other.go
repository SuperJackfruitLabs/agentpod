//go:build !unix

package superbench

func excludeHarnessScratch(RegisteredCapsule) error { return ErrRegisteredLayout }
