//go:build windows

package forgeapi

import "os"

// inheritOwner is a no-op: a separate-user stk install is Linux only.
func inheritOwner(string, os.FileInfo, string) {}
