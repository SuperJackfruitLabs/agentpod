package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/openclawerrors"
)

func fakeOpenClaw(t *testing.T, probe descriptor.VersionProbe) string {
	t.Helper()
	previous, previousNow := openclawErrorsVersion, openclawErrorsNow
	openclawErrorsVersion = func(context.Context) descriptor.VersionProbe { return probe }
	openclawErrorsNow = func() time.Time { return time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { openclawErrorsVersion, openclawErrorsNow = previous, previousNow })

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AGENTPOD_TURN_ERROR_SOCKET", "")
	if err := os.MkdirAll(filepath.Join(home, ".openclaw"), 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home, ".openclaw", "openclaw.json")
	if err := os.WriteFile(config, []byte("{\n  \"gateway\": {\n    \"port\": 18789\n  }\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return config
}

func testedOpenClaw() descriptor.VersionProbe {
	_, max := openclawerrors.TestedRange()
	return descriptor.VersionProbe{Status: descriptor.VersionKnown, Version: max, Reason: "fixture"}
}

func runOpenClawErrors(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := openclawErrorsCmd(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestOpenClawErrorsReviewWritesNothing(t *testing.T) {
	config := fakeOpenClaw(t, testedOpenClaw())
	before, _ := os.ReadFile(config)
	code, out, errOut := runOpenClawErrors(t, "enable")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, want := range []string{"+ index.js", "allowConversationAccess", "--apply"} {
		if !strings.Contains(out, want) {
			t.Errorf("review lacks %q:\n%s", want, out)
		}
	}
	if after, _ := os.ReadFile(config); !bytes.Equal(before, after) {
		t.Fatal("a review wrote the config")
	}
}

func TestOpenClawErrorsEnableStatusDisable(t *testing.T) {
	config := fakeOpenClaw(t, testedOpenClaw())
	before, _ := os.ReadFile(config)

	code, out, errOut := runOpenClawErrors(t, "enable", "--apply")
	if code != 0 {
		t.Fatalf("enable: %s", errOut)
	}
	if !strings.Contains(out, "restart") || strings.Contains(out, "restarted the gateway") {
		t.Errorf("enable should tell the operator to restart, and not claim it did:\n%s", out)
	}

	_, out, _ = runOpenClawErrors(t, "status")
	for _, want := range []string{"installed by apn", "enabled:  yes", "node intake: not listening"} {
		if !strings.Contains(out, want) {
			t.Errorf("status lacks %q:\n%s", want, out)
		}
	}

	if code, _, errOut := runOpenClawErrors(t, "disable", "--apply"); code != 0 {
		t.Fatalf("disable: %s", errOut)
	}
	after, _ := os.ReadFile(config)
	if !bytes.Equal(bytes.TrimSpace(before), bytes.TrimSpace(after)) {
		t.Errorf("disable did not restore the config:\n%s", after)
	}
}

func TestOpenClawErrorsRefusesAnUntestedOpenClaw(t *testing.T) {
	fakeOpenClaw(t, descriptor.VersionProbe{Status: descriptor.VersionKnown, Version: "2026.2.12"})
	code, _, errOut := runOpenClawErrors(t, "enable", "--apply")
	if code == 0 || !strings.Contains(errOut, "older than the oldest tested") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}
