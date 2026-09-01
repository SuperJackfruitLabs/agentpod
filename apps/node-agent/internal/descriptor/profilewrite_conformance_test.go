package descriptor

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestConformance runs the same cases against every registered ProfileWriter
// (see AllWriters), so a writer added for a later adapter is covered without
// this suite being edited.
func TestConformance(t *testing.T) {
	for _, w := range AllWriters() {
		w := w
		t.Run(w.Harness()+"/round trip", func(t *testing.T) {
			dir := seedProfile(t, w.Harness())
			if err := w.Write(dir, "@agent_writer-quill:id.agentpod.dev", "syt_token"); err != nil {
				t.Fatal(err)
			}
			// Read back with the REAL reader. This is the assertion that
			// catches a writer targeting a file its harness does not load.
			got := MatrixIDFromProfile(dir, "")
			if got == nil || *got != "@agent_writer-quill:id.agentpod.dev" {
				t.Fatalf("reader did not see the written identity: %v", got)
			}
		})
		t.Run(w.Harness()+"/refuses an unrecognised profile", func(t *testing.T) {
			dir := t.TempDir() // empty: no profile shape at all
			if err := w.Write(dir, "@a:h", "t"); err == nil {
				t.Fatal("expected a refusal, got a silent write")
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 0 {
				t.Fatal("refusal created files")
			}
		})
		t.Run(w.Harness()+"/refuses when credential keys are absent", func(t *testing.T) {
			// A profile whose shape this writer's harness recognises (so the
			// file-absent refusal above must not be what fires) but which has
			// never held a Matrix credential. Fix round 1 on Task 5: every
			// station this slice moves is already harness-mode, and therefore
			// already carries both keys — that is precisely where the reader
			// found its current identity. So an absent key here is not a stale
			// value to update, it is a shape with no station behind it yet
			// (or a harness never Matrix-enabled at all), and appending one in
			// would be speculative behaviour on the exact seam this task
			// polices. Refusal must leave the file untouched, the same as the
			// file-absent case.
			dir := seedRecognisedProfileWithoutCredential(t, w.Harness())
			before := readAllFiles(t, dir)
			if err := w.Write(dir, "@a:h", "syt_token"); err == nil {
				t.Fatal("expected a refusal, got a silent write")
			}
			after := readAllFiles(t, dir)
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("refusal modified the profile:\nbefore: %#v\nafter:  %#v", before, after)
			}
		})
		t.Run(w.Harness()+"/adjacent config survives", func(t *testing.T) {
			// Hermes .env carries other keys; auth.json carries provider
			// credentials. Losing them breaks the agent in a way that has
			// nothing to do with Matrix.
			dir := seedProfile(t, w.Harness())
			before := readAllFiles(t, dir)
			if err := w.Write(dir, "@agent_writer-quill:id.agentpod.dev", "syt_token"); err != nil {
				t.Fatal(err)
			}
			after := readAllFiles(t, dir)
			for name, content := range before {
				if !touchedByWriter(w, name) && after[name] != content {
					t.Fatalf("%s was modified but is not this writer's file", name)
				}
			}
			if !strings.Contains(after[authoritativeFile(w)], "ANTHROPIC_API_KEY=sk-seeded") {
				t.Fatal("an unrelated key in the written file was lost")
			}
		})
		t.Run(w.Harness()+"/token is not world readable", func(t *testing.T) {
			dir := seedProfile(t, w.Harness())
			if err := w.Write(dir, "@a:h", "syt_token"); err != nil {
				t.Fatal(err)
			}
			fi, err := os.Stat(filepath.Join(dir, authoritativeFile(w)))
			if err != nil {
				t.Fatal(err)
			}
			if fi.Mode().Perm()&0o077 != 0 {
				t.Fatalf("credential file is group/world readable: %v", fi.Mode().Perm())
			}
		})
		t.Run(w.Harness()+"/idempotent", func(t *testing.T) {
			dir := seedProfile(t, w.Harness())
			if err := w.Write(dir, "@a:h", "syt_token"); err != nil {
				t.Fatal(err)
			}
			first := readAllFiles(t, dir)
			if err := w.Write(dir, "@a:h", "syt_token"); err != nil {
				t.Fatal(err)
			}
			second := readAllFiles(t, dir)
			// go-cmp is not a dependency of this module; reflect.DeepEqual is
			// sufficient for a map[string]string comparison.
			if !reflect.DeepEqual(first, second) {
				t.Fatalf("second write changed the profile:\nfirst:  %#v\nsecond: %#v", first, second)
			}
		})
	}
}

// seedProfile creates a realistic on-disk profile for harness, including
// adjacent, non-Matrix configuration the writer must leave alone. Both
// Matrix credential keys are present (with stale values) — the update case.
func seedProfile(t *testing.T, harness string) string {
	t.Helper()
	dir := t.TempDir()

	switch harness {
	case "hermes":
		env := "" +
			"# hermes profile env\n" +
			"MATRIX_USER_ID=@agent_old-identity:id.agentpod.dev\n" +
			"MATRIX_ACCESS_TOKEN=syt_old-token\n" +
			"ANTHROPIC_API_KEY=sk-seeded\n"
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
			t.Fatalf("seed .env: %v", err)
		}
		// auth.json holds provider credentials unrelated to Matrix — present
		// so the writer has something adjacent to accidentally disturb.
		auth := `{"credential_pool":{"anthropic":"sk-pool"},"providers":{"anthropic":{}}}`
		if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(auth), 0o600); err != nil {
			t.Fatalf("seed auth.json: %v", err)
		}
	default:
		t.Fatalf("seedProfile: no seed defined for harness %q; add one alongside its writer", harness)
	}

	return dir
}

// seedRecognisedProfileWithoutCredential builds a profile shape the writer's
// harness recognises — its authoritative file exists — but which has never
// held a Matrix credential: neither key is present at all. This is distinct
// from seedProfile's "keys present, values stale" shape; see the fix-round-1
// conformance case that uses it.
func seedRecognisedProfileWithoutCredential(t *testing.T, harness string) string {
	t.Helper()
	dir := t.TempDir()

	switch harness {
	case "hermes":
		env := "" +
			"# hermes profile env, never Matrix-enabled\n" +
			"ANTHROPIC_API_KEY=sk-seeded\n"
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
			t.Fatalf("seed .env: %v", err)
		}
	default:
		t.Fatalf("seedRecognisedProfileWithoutCredential: no seed defined for harness %q; add one alongside its writer", harness)
	}

	return dir
}

// readAllFiles reads every regular file directly inside dir, keyed by name.
func readAllFiles(t *testing.T, dir string) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	out := make(map[string]string, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		out[e.Name()] = string(data)
	}
	return out
}

// authoritativeFile names the one file w.Write actually targets.
func authoritativeFile(w ProfileWriter) string {
	switch w.Harness() {
	case "hermes":
		return ".env"
	default:
		return ""
	}
}

// touchedByWriter reports whether name is the file w.Write is allowed to
// modify.
func touchedByWriter(w ProfileWriter, name string) bool {
	return name == authoritativeFile(w)
}
