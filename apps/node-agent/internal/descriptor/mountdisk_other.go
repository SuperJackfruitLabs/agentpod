//go:build !linux && !darwin

package descriptor

func mountUsedBytes(string) (int64, bool) { return 0, false }
