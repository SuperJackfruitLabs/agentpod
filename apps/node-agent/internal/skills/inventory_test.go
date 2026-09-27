package skills

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func put(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

const document = "---\nname: example\ndescription: |\n  A useful example\n---\nRead the local fixture.\n"

func scan(t *testing.T, root string, paths ...string) Inventory {
	t.Helper()
	specs := []RootSpec{}
	for _, p := range paths {
		specs = append(specs, RootSpec{RelativePath: p, Scope: "workspace"})
	}
	result, err := Scan(context.Background(), "codex:fixture", "codex", root, specs)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestPresenceIsNotEligibilityOrActivation(t *testing.T) {
	root := t.TempDir()
	put(t, root, ".agents/skills/example/SKILL.md", document)
	result := scan(t, root, ".agents/skills")
	if len(result.Skills) != 1 {
		t.Fatalf("%+v", result)
	}
	s := result.Skills[0]
	if s.Name != "example" || s.EntrypointDigest == nil || len(*s.EntrypointDigest) != 64 {
		t.Fatalf("%+v", s)
	}
	if s.Evidence.Present.Value == nil || !*s.Evidence.Present.Value {
		t.Fatal("presence missing")
	}
	if s.Evidence.Eligible.Value != nil || s.Evidence.Loaded.Value != nil || s.Evidence.Exercised.Value != nil || s.Source.ArtifactDigest != nil || s.EffectivePath != nil {
		t.Fatal("inferred unobserved state")
	}
	if result.Coverage.Complete || len(result.Coverage.Limitations) == 0 {
		t.Fatal("partial scan reported complete")
	}
	after, _ := os.ReadFile(filepath.Join(root, ".agents/skills/example/SKILL.md"))
	if string(after) != document {
		t.Fatal("inventory modified the skill")
	}
}
func TestScopeAndDuplicateNamesDoNotInventPrecedence(t *testing.T) {
	root := t.TempDir()
	put(t, root, "first/skills/example/SKILL.md", document)
	put(t, root, "first/.agents/skills/example/SKILL.md", document)
	put(t, root, "other/skills/private/SKILL.md", strings.Replace(document, "example", "private", -1))
	result := scan(t, filepath.Join(root, "first"), "skills", ".agents/skills")
	if len(result.Skills) != 2 {
		t.Fatalf("cross-profile inventory: %+v", result)
	}
	for _, s := range result.Skills {
		if s.Name != "example" || s.Shadowing.Status != "unknown" || len(s.Shadowing.Candidates) != 1 || s.EffectivePath != nil {
			t.Fatalf("guessed winner: %+v", s)
		}
	}
}
func TestSymlinksAndSpecialFilesAreNotRead(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	put(t, outside, "secret/SKILL.md", document)
	put(t, root, "skills/local/SKILL.md", document)
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "skills", "linked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret", "SKILL.md"), filepath.Join(root, "skills", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	result := scan(t, root, "skills")
	if len(result.Skills) != 1 || len(result.Issues) < 2 {
		t.Fatalf("symlinks were not recorded: %+v", result)
	}
	if err := os.Symlink(outside, filepath.Join(root, "external")); err != nil {
		t.Fatal(err)
	}
	result = scan(t, root, "external/secret")
	if len(result.Skills) != 0 || result.Coverage.Roots[0].Status != "unreadable" {
		t.Fatalf("symlink root accepted: %+v", result)
	}
}
func TestMalformedOversizedAndMissingAreVisible(t *testing.T) {
	root := t.TempDir()
	put(t, root, "skills/invalid/SKILL.md", "---\nname: one\nname: two\n---\n")
	put(t, root, "skills/oversized/SKILL.md", strings.Repeat("x", maxEntrypointBytes+1))
	put(t, root, "skills/valid/SKILL.md", document)
	result := scan(t, root, "skills", "absent")
	if len(result.Skills) != 1 || len(result.Issues) != 2 {
		t.Fatalf("malformed entries hidden: %+v", result)
	}
	if result.Coverage.Roots[1].Status != "missing" {
		t.Fatal("missing root indistinguishable from scanned")
	}
}
func TestRootsCannotEscapeAndCancellationIsNotAnEmptyPass(t *testing.T) {
	for _, p := range []string{"../other", "/other", ".", "skills/../../other", "skills\\..\\other"} {
		_, err := Scan(context.Background(), "x", "codex", t.TempDir(), []RootSpec{{RelativePath: p, Scope: "workspace"}})
		if err == nil {
			t.Fatalf("accepted root %q", p)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Scan(ctx, "x", "codex", t.TempDir(), []RootSpec{{RelativePath: "skills", Scope: "workspace"}}); err == nil {
		t.Fatal("cancelled inventory succeeded")
	}
}
func TestEntryLimitIsExplicit(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < maxSkills+1; i++ {
		put(t, root, filepath.Join("skills", fmt.Sprintf("fixture-%04d", i), "SKILL.md"), document)
	}
	result := scan(t, root, "skills")
	if len(result.Skills) != maxSkills || result.Coverage.Roots[0].Status != "truncated" {
		t.Fatalf("limit not visible: %d %+v", len(result.Skills), result.Coverage)
	}
}

func TestInventoryDoesNotExportBodiesOrArbitraryMetadata(t *testing.T) {
	root := t.TempDir()
	put(t, root, "skills/example/SKILL.md", "---\nname: example\ndescription: Safe summary\nmetadata:\n  fixture_secret: DO_NOT_EXPORT_METADATA\n---\nDO_NOT_EXPORT_BODY\n")
	data, err := json.Marshal(scan(t, root, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("DO_NOT_EXPORT")) {
		t.Fatal("raw content left the reader")
	}
}

func TestLargeDuplicateInventoryHasBoundedResponse(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < maxSkills; i++ {
		put(t, root, filepath.Join("skills", fmt.Sprintf("fixture-%04d", i), "SKILL.md"), "---\nname: duplicate\ndescription: "+strings.Repeat("x", 4096)+"\n---\n")
	}
	result := scan(t, root, "skills")
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > 2<<20 {
		t.Fatalf("inventory amplification: %d response bytes", len(data))
	}
	for _, s := range result.Skills {
		if len(s.Shadowing.Candidates) > 8 {
			t.Fatal("unbounded duplicate expansion")
		}
	}
	if len(result.Issues) == 0 {
		t.Fatal("truncated candidates must be visible")
	}
}

func TestNamedPipeEntrypointIsNotOpened(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "skills", "pipe")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, "SKILL.md"), 0600); err != nil {
		t.Fatal(err)
	}
	result := scan(t, root, "skills")
	if len(result.Skills) != 0 || len(result.Issues) == 0 {
		t.Fatal("special file was not rejected")
	}
}
