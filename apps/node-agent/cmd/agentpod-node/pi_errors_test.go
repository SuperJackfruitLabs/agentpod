package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/pierrors"
)

func fakePi(t *testing.T, version string) string {
	t.Helper()
	previous := piErrorsVersion
	piErrorsVersion = func(context.Context) descriptor.VersionProbe {
		return descriptor.VersionProbe{Status: descriptor.VersionKnown, Version: version}
	}
	t.Cleanup(func() { piErrorsVersion = previous })
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AGENTPOD_TURN_ERROR_SOCKET", "")
	return home
}

func runPiErrors(args ...string) (int, string, string) {
	var out, errOut bytes.Buffer
	code := piErrorsCmd(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestPiErrorsReviewWritesNothing(t *testing.T) {
	_, max := pierrors.TestedRange()
	home := fakePi(t, max)
	code, out, errOut := runPiErrors("enable")
	if code != 0 || !strings.Contains(out, "--apply") {
		t.Fatalf("exit %d, out %q, err %q", code, out, errOut)
	}
	if _, err := os.Stat(filepath.Join(home, ".pi")); !os.IsNotExist(err) {
		t.Fatal("a review wrote something")
	}
}

func TestPiErrorsEnableStatusDisable(t *testing.T) {
	min, _ := pierrors.TestedRange()
	home := fakePi(t, min)
	if code, _, errOut := runPiErrors("enable", "--apply"); code != 0 {
		t.Fatalf("enable: %s", errOut)
	}
	if _, err := os.Stat(pierrors.Target(home)); err != nil {
		t.Fatal("not installed:", err)
	}
	_, out, _ := runPiErrors("status")
	for _, want := range []string{"installed by apn", "node intake: not listening"} {
		if !strings.Contains(out, want) {
			t.Errorf("status lacks %q:\n%s", want, out)
		}
	}
	if code, _, errOut := runPiErrors("disable", "--apply"); code != 0 {
		t.Fatalf("disable: %s", errOut)
	}
	if _, err := os.Stat(pierrors.Target(home)); !os.IsNotExist(err) {
		t.Fatal("still installed after disable")
	}
}

func TestPiErrorsRefusesAnUntestedPi(t *testing.T) {
	fakePi(t, "0.70.0")
	if code, _, errOut := runPiErrors("enable", "--apply"); code == 0 || !strings.Contains(errOut, "older than the oldest tested") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}
