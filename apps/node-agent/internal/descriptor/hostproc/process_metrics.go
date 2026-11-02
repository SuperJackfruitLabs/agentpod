package hostproc

import (
	"os/exec"
	"strconv"
)

// GatherPidMetrics runs `ps` for pid and returns the parsed CPU%, resident
// memory (bytes), and uptime (seconds) as pointers. Metrics are best-effort:
// any failure (ps unavailable, unexpected output, parse error) yields all-nil
// so callers never fail Health() over a transient ps hiccup.
//
// Shared by the Hermes (per-profile process) and OpenClaw (shared gateway
// process) descriptors so the `ps -o %cpu,rss,etime` gathering lives in one place.
func GatherPidMetrics(pid int) (cpuPct *float64, memBytes *int64, uptimeSec *int64) {
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "%cpu=,rss=,etime=").Output()
	if err != nil {
		return nil, nil, nil
	}
	cpu, rssKB, up, perr := parsePsMetrics(string(out))
	if perr != nil {
		return nil, nil, nil
	}
	mem := rssKB * 1024
	return &cpu, &mem, &up
}
