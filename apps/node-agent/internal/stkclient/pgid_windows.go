//go:build windows

package stkclient

import "os/exec"

func ownProcessGroup(cmd *exec.Cmd) {}
