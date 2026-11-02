package harnesses

import (
	"path/filepath"
	"testing"
)

// testdataHermesHome returns the absolute path of the fixture .hermes home.
func testdataHermesHome(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", "hermes", "testdata", "hermes", ".hermes"))
	if err != nil {
		t.Fatalf("resolve testdata: %v", err)
	}
	return abs
}
