package harnesses

import (
	"path/filepath"
	"testing"
)

// testdataOpenClawHome returns the absolute path of the fixture .openclaw home.
func testdataOpenClawHome(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", "openclaw", "testdata", "openclaw", ".openclaw"))
	if err != nil {
		t.Fatalf("resolve testdata: %v", err)
	}
	return abs
}
