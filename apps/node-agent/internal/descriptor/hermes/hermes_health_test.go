package hermes

import (
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// TestHermesProcessRunning_MatchesProfileLongForm proves the process detector
// recognises a profile launched in the supervisor's LONG form
// (`... hermes_cli.main --profile <name> gateway ...`), not only the direct
// `hermes -p <name> gateway` short form. When the Hermes main gateway respawns a
// profile it uses the long form; before this fix such profiles were reported
// stopped in the console while actually running (observed live: analyst-echo).
func TestHermesProcessRunning_MatchesProfileLongForm(t *testing.T) {
	name := "tddprof-longform"

	// Stand-in process whose command line carries the long-form marker
	// (`--profile <name> gateway`). We deliberately OMIT the "hermes"/
	// "hermes_cli.main" token: the profile pattern does not need it, and
	// including it would make this fixture match the broad root-key
	// `pgrep -f "hermes"` used by other lifecycle tests. The compound
	// `sleep …; true` keeps the shell alive (no exec-replace) so the marker
	// stays in argv; Setpgid lets cleanup reap it via the process group.
	proc := exec.Command("/bin/sh", "-c",
		"sleep 30; true # --profile "+name+" gateway run --replace")
	proc.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := proc.Start(); err != nil {
		t.Fatalf("start stand-in process: %v", err)
	}
	t.Cleanup(func() {
		if proc.Process != nil {
			if pgid, err := syscall.Getpgid(proc.Process.Pid); err == nil {
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			} else {
				_ = proc.Process.Kill()
			}
		}
		_ = proc.Wait()
	})
	time.Sleep(150 * time.Millisecond)

	running, _ := hermesProcessRunning("hermes:" + name)
	if !running {
		t.Errorf("hermesProcessRunning should match the --profile long form for %q", name)
	}
}

// TestHermesHealth_PopulatesMetricsWhenRunning proves the Hermes descriptor
// reports live per-profile process metrics (PID/CPU/Mem/Uptime), not just
// Running/Disk. Hermes runs a SEPARATE process per profile, so these are honest
// per-agent numbers (unlike OpenClaw's shared gateway).
//
// We stand up a stand-in process whose command line contains the profile's
// pgrep pattern ("hermes -p <name> gateway") so hermesProcessRunning/hermesPID
// match it, then assert Health() fills in the metric fields.
func TestHermesHealth_PopulatesMetricsWhenRunning(t *testing.T) {
	home := testdataHermesHome(t)
	d := NewHermes(home)

	// The marker "-p coder-kai gateway" lives inside the -c script (argv), so
	// pgrep -f matches the profile pattern. We deliberately OMIT the "hermes"
	// token — it is not needed for the profile pattern, and including it would
	// make this fixture match the broad root-key `pgrep -f "hermes"` used by
	// other lifecycle tests (a cross-test collision). The compound command
	// (`sleep …; true`) keeps the shell from exec-replacing itself, preserving
	// the marker; Setpgid lets cleanup reap the shell AND its sleep child.
	proc := exec.Command("/bin/sh", "-c", "sleep 30; true # -p coder-kai gateway run")
	proc.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := proc.Start(); err != nil {
		t.Fatalf("start stand-in process: %v", err)
	}
	t.Cleanup(func() {
		if proc.Process != nil {
			if pgid, err := syscall.Getpgid(proc.Process.Pid); err == nil {
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			} else {
				_ = proc.Process.Kill()
			}
		}
		_ = proc.Wait()
	})

	// Give the OS a moment to make the process visible to pgrep.
	time.Sleep(150 * time.Millisecond)

	h, err := d.Health("hermes:coder-kai")
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if !h.Running {
		t.Fatal("expected Running=true with stand-in process alive")
	}
	if h.PID == nil {
		t.Error("expected PID to be populated when running")
	}
	if h.CpuPct == nil {
		t.Error("expected CpuPct to be populated when running")
	}
	if h.MemBytes == nil {
		t.Error("expected MemBytes to be populated when running")
	} else if *h.MemBytes <= 0 {
		t.Errorf("MemBytes should be > 0, got %d", *h.MemBytes)
	}
	if h.UptimeSec == nil {
		t.Error("expected UptimeSec to be populated when running")
	}
}
