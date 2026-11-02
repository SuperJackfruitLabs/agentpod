//go:build !linux && !darwin

package hostfs

func MountUsedBytes(string) (int64, bool) { return 0, false }
