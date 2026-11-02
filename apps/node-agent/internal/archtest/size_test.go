// Package archtest holds the node-agent's size ratchets: numbers that may only fall.
//
// Phase 0 of the modularity work (docs/contributor/code-quality.md at the repository root).
// Nothing is restructured yet; these record today's shape so it cannot quietly get worse. Each
// check fails in both directions: growing past a recorded size is a regression, and shrinking
// below it fails too, asking for the record to be lowered, so it can never go stale.
//
// Only shipped code counts: _test.go files and testdata are left out.
package archtest

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const (
	// fileLimit is the most lines a shipped .go file may have without an entry in oversizeFiles.
	fileLimit = 1000
	// packageLimit is the most lines a package (one directory) may have without an entry in
	// oversizePackages.
	packageLimit = 4000
)

// oversizeFiles lists the files over fileLimit and the most lines each may have. Lower these;
// never raise them.
var oversizeFiles = map[string]int{
	"internal/forgeapi/instances.go": 1164,
}

// oversizePackages lists the packages over packageLimit and the most lines each may have.
// Lower these; never raise them.
var oversizePackages = map[string]int{
	"internal/forgeapi": 5344,
}

// shippedSizes returns the line count of every shipped .go file under root, keyed by its
// slash-separated path relative to root (io/fs paths are slash-separated already).
func shippedSizes(t *testing.T, root string) map[string]int {
	t.Helper()
	sizes := map[string]int{}
	fsys := os.DirFS(root)
	err := fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, err := fs.ReadFile(fsys, path)
		if err != nil {
			return err
		}
		sizes[path] = bytes.Count(body, []byte("\n"))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return sizes
}

// allowed is the most a name may have: its recorded size, or the limit.
func allowed(name string, limit int, recorded map[string]int) int {
	if n, ok := recorded[name]; ok {
		return n
	}
	return limit
}

// ratchet reports sizes over their limit and recorded sizes that have fallen.
func ratchet(sizes map[string]int, limit int, recorded map[string]int) (grown, stale []string) {
	for name, n := range sizes {
		if n > allowed(name, limit, recorded) {
			grown = append(grown, name)
		}
	}
	for name, size := range recorded {
		if sizes[name] < size {
			stale = append(stale, name)
		}
	}
	sort.Strings(grown)
	sort.Strings(stale)
	return grown, stale
}

func moduleRoot() string { return filepath.Join("..", "..") }

func TestNoShippedFileGrowsPastItsLimit(t *testing.T) {
	sizes := shippedSizes(t, moduleRoot())
	grown, stale := ratchet(sizes, fileLimit, oversizeFiles)
	for _, f := range grown {
		t.Errorf("%s has %d lines; the limit is %d. Split it rather than raising the limit.", f, sizes[f], allowed(f, fileLimit, oversizeFiles))
	}
	for _, f := range stale {
		t.Errorf("%s shrank to %d lines (recorded %d); lower or remove its oversizeFiles entry", f, sizes[f], oversizeFiles[f])
	}
}

func TestNoPackageGrowsPastItsLimit(t *testing.T) {
	packages := map[string]int{}
	for file, n := range shippedSizes(t, moduleRoot()) {
		packages[filepath.ToSlash(filepath.Dir(file))] += n
	}
	grown, stale := ratchet(packages, packageLimit, oversizePackages)
	for _, p := range grown {
		t.Errorf("package %s has %d lines; the limit is %d. Move code out rather than raising the limit.", p, packages[p], allowed(p, packageLimit, oversizePackages))
	}
	for _, p := range stale {
		t.Errorf("package %s shrank to %d lines (recorded %d); lower or remove its oversizePackages entry", p, packages[p], oversizePackages[p])
	}
}

func TestRatchetSeesGrowthAndShrinkage(t *testing.T) {
	grown, stale := ratchet(
		map[string]int{"small": 10, "new-big": 30, "held": 50, "shrunk": 40},
		20,
		map[string]int{"held": 50, "shrunk": 45, "gone": 25},
	)
	if strings.Join(grown, ",") != "new-big" {
		t.Errorf("grown = %v, want [new-big]", grown)
	}
	if strings.Join(stale, ",") != "gone,shrunk" {
		t.Errorf("stale = %v, want [gone shrunk]", stale)
	}
}
