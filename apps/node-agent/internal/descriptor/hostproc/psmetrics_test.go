package hostproc

import (
	"testing"
)

// TestParsePsMetrics covers the happy-path etime formats and a malformed line.
func TestParsePsMetrics_FullLine(t *testing.T) {
	// "12.5 204800 01:02:03" → cpu 12.5, rss 204800, uptime 3723 (1h2m3s)
	cpu, rss, uptime, err := parsePsMetrics("12.5 204800 01:02:03")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cpu != 12.5 {
		t.Errorf("cpu: want 12.5, got %v", cpu)
	}
	if rss != 204800 {
		t.Errorf("rssKB: want 204800, got %v", rss)
	}
	if uptime != 3723 {
		t.Errorf("uptimeSec: want 3723, got %v", uptime)
	}
}

func TestParsePsMetrics_EtimeMMSS(t *testing.T) {
	// MM:SS: "05:30" → 330 seconds
	_, _, uptime, err := parsePsMetrics("5.0 102400 05:30")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if uptime != 330 {
		t.Errorf("uptimeSec: want 330, got %v", uptime)
	}
}

func TestParsePsMetrics_EtimeDHHMMSS(t *testing.T) {
	// D-HH:MM:SS: "2-01:00:00" → 2*86400 + 1*3600 = 176400 seconds
	_, _, uptime, err := parsePsMetrics("0.1 512000 2-01:00:00")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if uptime != 176400 {
		t.Errorf("uptimeSec: want 176400, got %v", uptime)
	}
}

func TestParsePsMetrics_Malformed(t *testing.T) {
	_, _, _, err := parsePsMetrics("notvalid")
	if err == nil {
		t.Fatal("expected error for malformed input, got nil")
	}
}
