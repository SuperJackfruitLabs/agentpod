package hostfs

import (
	"testing"
)

// --- safeJoin tests ---

func TestSafeJoin_Normal(t *testing.T) {
	got, err := SafeJoin("/workspace", "subdir/file.txt")
	if err != nil {
		t.Fatalf("safeJoin normal: %v", err)
	}
	if got != "/workspace/subdir/file.txt" {
		t.Fatalf("safeJoin: got %s", got)
	}
}

func TestSafeJoin_DotDotEscape(t *testing.T) {
	_, err := SafeJoin("/workspace", "../etc/passwd")
	if err == nil {
		t.Fatal("expected error for .. escape")
	}
}

func TestSafeJoin_AbsolutePath(t *testing.T) {
	_, err := SafeJoin("/workspace", "/etc/passwd")
	if err == nil {
		t.Fatal("expected error for absolute path")
	}
}

func TestSafeJoin_RootItself(t *testing.T) {
	got, err := SafeJoin("/workspace", ".")
	if err != nil {
		t.Fatalf("safeJoin root dot: %v", err)
	}
	if got != "/workspace" {
		t.Fatalf("safeJoin root dot: got %s", got)
	}
}
