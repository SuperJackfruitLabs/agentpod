package hermes

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHermesNativeReadinessOpensOnTheProbedVersion(t *testing.T) {
	binDir := t.TempDir()
	bin := filepath.Join(binDir, "hermes")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'Hermes Agent v0.21.3'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	h := NewHermes(testdataHermesHome(t)).(*Descriptor)
	got, err := h.NativeSkillReadiness(context.Background(), "hermes:coder-kai")
	// This version is the one a disposable profile was probed on, so readiness
	// opens. It was asserted closed while Hermes had no verified placement
	// root; the assertion moves with the behaviour.
	if err != nil || !got.Ready || got.AdapterPath != bin || got.EngineVersion != "0.21.3" {
		t.Fatalf("readiness = %+v, err = %v", got, err)
	}
	// An open gate must still name what it does not cover.
	if !strings.Contains(got.Reason, "external_dirs") {
		t.Fatalf("reason does not say registration is still separate: %q", got.Reason)
	}
	if _, err := h.NativeSkillReadiness(context.Background(), "hermes:missing"); err == nil {
		t.Fatal("undetected profile accepted")
	}
}

// Readiness names one probed version. Another may behave identically, but
// nothing has observed it, so the gate stays closed rather than generalising.
func TestHermesNativeReadinessStaysClosedOffTheProbedVersion(t *testing.T) {
	for _, version := range []string{"Hermes Agent v0.20.9", "Hermes Agent v0.22.0", ""} {
		t.Run(version, func(t *testing.T) {
			binDir := t.TempDir()
			bin := filepath.Join(binDir, "hermes")
			body := "#!/bin/sh\necho '" + version + "'\n"
			if version == "" {
				body = "#!/bin/sh\nexit 1\n"
			}
			if err := os.WriteFile(bin, []byte(body), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", binDir)
			h := NewHermes(testdataHermesHome(t)).(*Descriptor)
			got, err := h.NativeSkillReadiness(context.Background(), "hermes:coder-kai")
			if err != nil {
				t.Fatal(err)
			}
			if got.Ready {
				t.Fatalf("an unprobed version opened the gate: %+v", got)
			}
			if got.Reason == "" {
				t.Fatal("a closed gate must name its condition")
			}
		})
	}
}

// Loading defers to a closed gate rather than running the harness report.
func TestHermesNativeLoadingDefersToAClosedReadinessGate(t *testing.T) {
	binDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(binDir, "hermes"), []byte("#!/bin/sh\necho 'Hermes Agent v0.19.0'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	h := NewHermes(testdataHermesHome(t)).(*Descriptor)
	got, err := h.NativeSkillLoading(context.Background(), "hermes:coder-kai", []string{"sjl-fixture"})
	if err != nil || got.Value != nil || got.Reason == "" {
		t.Fatalf("loading = %+v, err = %v", got, err)
	}
}
