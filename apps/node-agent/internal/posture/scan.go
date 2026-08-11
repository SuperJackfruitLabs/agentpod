package posture

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

// Scan runs every check and returns a graded report.
//
// harnesses is the set detected on this host; passing it in (rather than
// detecting here) keeps this package free of any dependency on the descriptor
// layer, so the checks stay unit-testable.
func Scan(ctx context.Context, home string, harnesses []string, stations int) Report {
	hostname, _ := os.Hostname()

	findings := CheckCredentialFiles(home, harnesses)
	findings = append(findings, CheckStationCredentials(home)...)
	findings = append(findings, CheckConfigDirs(home)...)
	findings = append(findings, CheckListeners(ctx)...)
	Sort(findings)

	return Report{
		Hostname: hostname,
		Stations: stations,
		Findings: findings,
		Grade:    Grade(findings),
	}
}

const (
	bold  = "\033[1m"
	dim   = "\033[2m"
	red   = "\033[31m"
	amber = "\033[33m"
	green = "\033[32m"
	reset = "\033[0m"
)

func colour(enabled bool, code, s string) string {
	if !enabled {
		return s
	}
	return code + s + reset
}

// Render writes a human-readable report.
//
// The failures come first and carry their remedy inline, because the person
// running this is not reading a reference — they want to know whether anything
// is wrong and what to type if it is.
func Render(w io.Writer, r Report, useColour bool) {
	fmt.Fprintf(w, "\n%s  %s   %d station(s)\n\n",
		colour(useColour, bold, "agentpod scan"), colour(useColour, dim, r.Hostname), r.Stations)

	var fails, unknowns, passes int
	for _, f := range r.Findings {
		switch f.Status {
		case StatusFail:
			fails++
		case StatusUnknown:
			unknowns++
		default:
			passes++
		}
	}

	for _, f := range r.Findings {
		if f.Status != StatusFail {
			continue
		}
		marker := colour(useColour, red, "✗")
		sev := strings.ToUpper(string(f.Severity))
		if f.Severity == SeverityWarning {
			marker = colour(useColour, amber, "!")
		}
		fmt.Fprintf(w, "  %s %s  %s\n", marker, colour(useColour, bold, sev), f.Title)
		if f.Harness != "" {
			fmt.Fprintf(w, "      harness: %s\n", f.Harness)
		}
		fmt.Fprintf(w, "      %s\n", f.Detail)
		if f.Remedy != "" {
			fmt.Fprintf(w, "      %s %s\n", colour(useColour, dim, "fix:"), f.Remedy)
		}
		fmt.Fprintln(w)
	}

	for _, f := range r.Findings {
		if f.Status != StatusUnknown {
			continue
		}
		fmt.Fprintf(w, "  %s %s\n      %s\n", colour(useColour, amber, "?"), f.Title, f.Detail)
		if f.Remedy != "" {
			fmt.Fprintf(w, "      %s %s\n", colour(useColour, dim, "try:"), f.Remedy)
		}
		fmt.Fprintln(w)
	}

	gradeColour := green
	switch r.Grade {
	case "F":
		gradeColour = red
	case "C", "B":
		gradeColour = amber
	}

	fmt.Fprintf(w, "  %s %s   %s\n",
		colour(useColour, bold, "grade"),
		colour(useColour, gradeColour, r.Grade),
		colour(useColour, dim, fmt.Sprintf("%d checked · %d failed · %d could not be determined", passes+fails+unknowns, fails, unknowns)))

	switch r.Grade {
	case "A":
		fmt.Fprintf(w, "  %s\n", colour(useColour, dim, "Nothing exposed, nothing world-readable."))
	case "F":
		fmt.Fprintf(w, "  %s\n", colour(useColour, red, "An agent on this machine is reachable by others, or its keys are."))
	}
	fmt.Fprintln(w)
}
