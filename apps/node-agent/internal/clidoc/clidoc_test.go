package clidoc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A miniature binary: a dispatch switch, a FlagSet, a hand-parsed flag and an env read.
const fakeMain = `package main

import (
	"flag"
	"os"
)

func main() {
	switch os.Args[1] {
	case "greet":
		greet(os.Args[2:])
	case "-h", "--help":
	}
}

func greet(args []string) {
	switch args[0] {
	case "loud", "quiet":
	}
	fs := flag.NewFlagSet("greet", flag.ExitOnError)
	fs.String("name", "world", "who to greet")
	fs.Int("times", 1, "how many " + "times")
	for _, a := range args {
		if a == "--dry-run" {
		}
	}
	_ = os.Getenv("FAKE_HOME")
}
`

func fakeBinary() Binary {
	return Binary{
		Name: "fake", Program: "fake-bin", Title: "fake reference", Description: "d",
		Regenerate: "go test -update", HelpCommand: "fake help %s", Groups: []string{"Main"},
		Env:  []Env{{Name: "FAKE_HOME", Meaning: "where"}},
		Auth: "nothing", Exit: "0 on success.",
		Commands: []Command{
			{Path: "", Dispatch: []Dispatch{{Func: "main", Tag: "os.Args[1]"}}},
			{
				Path: "greet", Group: "Main", Summary: "Greet.", Example: "fake greet loud",
				Dispatch: []Dispatch{{Func: "greet", Tag: "args[0]"}},
			},
			{
				Path: "greet loud", Summary: "Loudly.", Example: "fake greet loud --name you",
				Handlers: []string{"greet"},
				Flags: []Flag{
					{Name: "name", Arg: "WHO"},
					{Name: "times", Arg: "N"},
					{Name: "dry-run", Usage: "print, do not greet"},
				},
			},
			{Path: "greet quiet", Summary: "Quietly.", Example: "fake greet quiet"},
		},
	}
}

func fakeSource(t *testing.T) *Source {
	t.Helper()
	src, err := Parse(map[string]string{"main.go": fakeMain})
	if err != nil {
		t.Fatal(err)
	}
	return src
}

func mustClean(t *testing.T, b Binary, src *Source) {
	t.Helper()
	if errs := Check(b, src); len(errs) > 0 {
		t.Fatalf("expected a clean reference, got %v", errs)
	}
}

func wantError(t *testing.T, b Binary, src *Source, substr string) {
	t.Helper()
	for _, e := range Check(b, src) {
		if strings.Contains(e.Error(), substr) {
			return
		}
	}
	t.Fatalf("expected an error containing %q, got %v", substr, Check(b, src))
}

func TestCheckPassesAMatchingReference(t *testing.T) {
	mustClean(t, fakeBinary(), fakeSource(t))
}

// Each of these is the reference losing something the source still has; each must fail.
func TestCheckCatchesAMissingSubcommand(t *testing.T) {
	b := fakeBinary()
	b.Commands = b.Commands[:3] // drop "greet quiet"
	wantError(t, b, fakeSource(t), "fake greet quiet is dispatched but has no reference entry")
}

func TestCheckCatchesAMissingTopLevelCommand(t *testing.T) {
	b := fakeBinary()
	b.Commands = []Command{b.Commands[0]}
	wantError(t, b, fakeSource(t), "fake greet is dispatched but has no reference entry")
}

func TestCheckCatchesAnEntryNothingDispatches(t *testing.T) {
	b := fakeBinary()
	b.Commands = append(b.Commands, Command{Path: "greet whisper", Summary: "s", Example: "e"})
	wantError(t, b, fakeSource(t), "fake greet whisper has a reference entry but nothing dispatches it")
}

func TestCheckCatchesAnUndocumentedFlag(t *testing.T) {
	b := fakeBinary()
	b.Commands[2].Flags = b.Commands[2].Flags[1:] // drop --name
	wantError(t, b, fakeSource(t), "--name is declared in greet but documented on none of")
}

func TestCheckCatchesAnUndocumentedHandParsedFlag(t *testing.T) {
	b := fakeBinary()
	b.Commands[2].Flags = b.Commands[2].Flags[:2] // drop --dry-run
	wantError(t, b, fakeSource(t), "--dry-run is declared in greet")
}

func TestCheckCatchesADocumentedFlagThatDoesNotExist(t *testing.T) {
	b := fakeBinary()
	b.Commands[2].Flags = append(b.Commands[2].Flags, Flag{Name: "colour", Arg: "C"})
	wantError(t, b, fakeSource(t), "documents --colour, which none of [greet] declares")
}

func TestCheckCatchesAnUnlistedEnvironmentVariable(t *testing.T) {
	b := fakeBinary()
	b.Env = nil
	wantError(t, b, fakeSource(t), "$FAKE_HOME is read by fake")
}

func TestCheckCatchesAMissingExample(t *testing.T) {
	b := fakeBinary()
	b.Commands[3].Example = ""
	wantError(t, b, fakeSource(t), "fake greet quiet: no example")
}

func TestCheckRequiresDispatchForAParent(t *testing.T) {
	b := fakeBinary()
	b.Commands[1].Dispatch = nil
	wantError(t, b, fakeSource(t), "fake greet has subcommands but no Dispatch")
}

func TestRenderTakesFlagDetailFromTheSource(t *testing.T) {
	page, err := Render(fakeBinary(), fakeSource(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"| `--name WHO` | string | `world` | Who to greet. |",
		"| `--times N` | int | `1` | How many times. |",
		"| `--dry-run` | bool | `false` | Print, do not greet. |",
		"### fake greet loud",
		"| `$FAKE_HOME` | where |",
		"[`fake greet`](#fake-greet)",
	} {
		if !strings.Contains(page, want) {
			t.Errorf("page missing %q:\n%s", want, page)
		}
	}
}

func TestSyncFailsWhenThePageIsStale(t *testing.T) {
	b, src := fakeBinary(), fakeSource(t)
	path := filepath.Join(t.TempDir(), "fake.md")
	if err := Sync(b, src, path, true); err != nil {
		t.Fatal(err)
	}
	if err := Sync(b, src, path, false); err != nil {
		t.Fatalf("a freshly written page should match: %v", err)
	}
	b.Commands[3].Summary = "Very quietly."
	if err := Sync(b, src, path, false); err == nil || !strings.Contains(err.Error(), "out of date") {
		t.Fatalf("a changed table should make the committed page stale, got %v", err)
	}
	if err := os.WriteFile(path, []byte("edited by hand"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Sync(fakeBinary(), src, path, false); err == nil {
		t.Fatal("a hand-edited page should fail")
	}
}

// Two commands parsed in one function, each with its own FlagSet: a scoped handler sees only
// its own set's flags, so one command's --force cannot borrow the other's description.
func TestScopedHandlerSeesOnlyItsFlagSet(t *testing.T) {
	src, err := Parse(map[string]string{"main.go": `package main

import "flag"

func main() {
	switch x {
	case "a":
		fs := flag.NewFlagSet("a", flag.ExitOnError)
		fs.Bool("force", false, "short")
	case "b":
		fs := flag.NewFlagSet("b", flag.ExitOnError)
		fs.Bool("force", false, "a much longer description")
		fs.Bool("check", false, "check only")
	}
}
`})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := src.Flags("main/a")
	if len(a) != 1 || a["force"].Usage != "short" {
		t.Fatalf("main/a = %+v", a)
	}
	b, _ := src.Flags("main/b")
	if len(b) != 2 || b["force"].Usage != "a much longer description" {
		t.Fatalf("main/b = %+v", b)
	}
}

func TestCodeFlagsLeavesExistingCodeAlone(t *testing.T) {
	got := CodeFlags("use --json, or `--json` (--x)")
	want := "use `--json`, or `--json` (`--x`)"
	if got != want {
		t.Fatalf("CodeFlags = %q, want %q", got, want)
	}
}
