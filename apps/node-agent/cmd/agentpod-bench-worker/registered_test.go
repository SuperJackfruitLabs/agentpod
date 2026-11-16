package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestRegisteredCLIChild(t *testing.T) {
	if os.Getenv("REGISTERED_CLI_TEST_CHILD") != "1" {
		return
	}
	for i, a := range os.Args {
		if a == "--" {
			os.Exit(entryInput(os.Args[i+1:], os.Stdin, os.Stdout, os.Stderr))
		}
	}
	os.Exit(99)
}
func TestRegisteredCLIRefusesFrameWithClosedDiagnostic(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte("private-token-never-print")
	sum := sha256.Sum256(raw)
	cmd := exec.CommandContext(t.Context(), exe, "-test.run=^TestRegisteredCLIChild$", "--", "registered-v1", hex.EncodeToString(sum[:]))
	cmd.Env = []string{"REGISTERED_CLI_TEST_CHILD=1"}
	cmd.Stdin = bytes.NewReader(append([]byte{0, 0, 0, byte(len(raw) & 255)}, raw...))
	var out, logs bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &logs
	err = cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || out.Len() != 0 || logs.String() != "registered worker refused: frame\n" {
		t.Fatalf("wrong refusal %v stdout=%q stderr=%q", err, out.String(), logs.String())
	}
	if strings.Contains(logs.String(), string(raw)) {
		t.Fatal("private input leaked")
	}
}
