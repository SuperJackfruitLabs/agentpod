package pierrors

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

var tested = Gate{Allowed: true, Reason: "tested"}

func TestEnableInstallsOneFileWherePiLooks(t *testing.T) {
	home := t.TempDir()
	plan, err := PlanEnable(home, tested)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Action != "add" {
		t.Fatalf("action = %q, want add", plan.Action)
	}
	if err := Apply(plan); err != nil {
		t.Fatal(err)
	}
	// Top level, not a subdirectory: pi-acp's session banner lists top-level
	// extension files only, and a reader should be able to see it is there.
	target := filepath.Join(home, ".pi", "agent", "extensions", "agentpod-errors.ts")
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(Embedded()) {
		t.Fatal("installed file differs from the embedded extension")
	}

	again, _ := PlanEnable(home, tested)
	if again.Action != "keep" {
		t.Errorf("second enable action = %q, want keep", again.Action)
	}
}

func TestEnableReplacesAChangedCopy(t *testing.T) {
	home := t.TempDir()
	target := Target(home)
	os.MkdirAll(filepath.Dir(target), 0o755)
	os.WriteFile(target, []byte("// old"), 0o644)
	plan, _ := PlanEnable(home, tested)
	if plan.Action != "replace" {
		t.Fatalf("action = %q, want replace", plan.Action)
	}
}

func TestEnableRefusesAnUntestedPi(t *testing.T) {
	if _, err := PlanEnable(t.TempDir(), Gate{Reason: "0.70.0 is older than 0.84.1"}); err == nil {
		t.Fatal("enable went ahead on an untested Pi")
	}
}

func TestDisableRemovesOnlyItsFile(t *testing.T) {
	home := t.TempDir()
	plan, _ := PlanEnable(home, tested)
	Apply(plan)
	other := filepath.Join(home, ".pi", "agent", "extensions", "mine.ts")
	os.WriteFile(other, []byte("// the operator's"), 0o644)

	off := PlanDisable(home)
	if off.Action != "remove" {
		t.Fatalf("action = %q", off.Action)
	}
	if err := Apply(off); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(Target(home)); !os.IsNotExist(err) {
		t.Error("extension still installed")
	}
	if _, err := os.Stat(other); err != nil {
		t.Error("disable removed someone else's extension")
	}
	if PlanDisable(home).Action != "keep" {
		t.Error("a second disable would do something")
	}
}

func TestCheckPi(t *testing.T) {
	min, max := TestedRange()
	for _, v := range []string{min, max} {
		if g := CheckPi("known", v, ""); !g.Allowed {
			t.Errorf("%s refused: %s", v, g.Reason)
		}
	}
	if g := CheckPi("known", "0.70.2", ""); g.Allowed {
		t.Error("0.70.2 allowed")
	}
	if g := CheckPi("known", "9.0.0", ""); g.Allowed {
		t.Error("an untested newer Pi allowed")
	}
	if g := CheckPi("undetermined", "", "timed out"); g.Allowed {
		t.Error("undetermined allowed")
	}
}

func TestObserve(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AGENTPOD_TURN_ERROR_SOCKET", "")
	if st := Observe(home); st.Installed || st.IntakeListening {
		t.Errorf("fresh: %+v", st)
	}
	plan, _ := PlanEnable(home, tested)
	Apply(plan)
	dir, _ := os.MkdirTemp("/tmp", "pie")
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	t.Setenv("AGENTPOD_TURN_ERROR_SOCKET", sock)
	if st := Observe(home); !st.Installed || !st.Current || !st.IntakeListening {
		t.Errorf("installed + listening: %+v", st)
	}
}
