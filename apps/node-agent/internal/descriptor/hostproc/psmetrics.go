package hostproc

import (
	"fmt"
	"strconv"
	"strings"
)

// parsePsMetrics parses one line of `ps -p <pid> -o %cpu=,rss=,etime=` output.
// Fields are whitespace-split: cpu%, rssKB, etime.
// etime formats accepted: MM:SS, HH:MM:SS, D-HH:MM:SS.
// Returns an error on malformed input.
func parsePsMetrics(out string) (cpuPct float64, rssKB int64, uptimeSec int64, err error) {
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) != 3 {
		err = fmt.Errorf("parsePsMetrics: expected 3 fields, got %d: %q", len(fields), out)
		return
	}
	cpuPct, err = strconv.ParseFloat(fields[0], 64)
	if err != nil {
		err = fmt.Errorf("parsePsMetrics: cpu: %w", err)
		return
	}
	rssKB, err = strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		err = fmt.Errorf("parsePsMetrics: rss: %w", err)
		return
	}
	uptimeSec, err = parseEtime(fields[2])
	if err != nil {
		err = fmt.Errorf("parsePsMetrics: etime: %w", err)
	}
	return
}

// parseEtime converts a ps etime string to seconds.
// Accepted formats: MM:SS, HH:MM:SS, D-HH:MM:SS.
func parseEtime(s string) (int64, error) {
	var days int64
	if idx := strings.Index(s, "-"); idx != -1 {
		d, err := strconv.ParseInt(s[:idx], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: days: %w", err)
		}
		days = d
		s = s[idx+1:]
	}

	parts := strings.Split(s, ":")
	switch len(parts) {
	case 2: // MM:SS
		mm, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: minutes: %w", err)
		}
		ss, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: seconds: %w", err)
		}
		return days*86400 + mm*60 + ss, nil
	case 3: // HH:MM:SS
		hh, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: hours: %w", err)
		}
		mm, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: minutes: %w", err)
		}
		ss, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parseEtime: seconds: %w", err)
		}
		return days*86400 + hh*3600 + mm*60 + ss, nil
	default:
		return 0, fmt.Errorf("parseEtime: unexpected etime format %q", s)
	}
}
