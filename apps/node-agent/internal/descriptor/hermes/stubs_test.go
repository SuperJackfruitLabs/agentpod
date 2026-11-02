package hermes

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// writeFakePgrep writes an executable shell script named "pgrep" in tmpDir.
// The script records its arguments to a log file and always exits 1
// (no matching process), simulating an environment where no Hermes process
// runs.
func writeFakePgrep(t *testing.T, tmpDir string) string {
	t.Helper()
	logFile := filepath.Join(tmpDir, "pgrep.log")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %s
exit 1
`, logFile)
	scriptPath := filepath.Join(tmpDir, "pgrep")
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("writeFakePgrep: %v", err)
	}
	return logFile
}

// readLog returns the contents of logFile, or "" if the file does not exist.
func readLog(t *testing.T, logFile string) string {
	t.Helper()
	if _, err := os.Stat(logFile); os.IsNotExist(err) {
		return ""
	}
	b, err := os.ReadFile(logFile)
	if err != nil {
		t.Fatalf("readLog %s: %v", logFile, err)
	}
	return string(b)
}
