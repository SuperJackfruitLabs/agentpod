package stkclient

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestMain lets this test binary act as its own stk stub (macOS SIGKILLs
// copied system binaries, so we re-exec ourselves). The mode comes from
// STKCLIENT_STUB in the child's environment:
//
//	sleep: write our pid to STKCLIENT_PIDFILE, then sleep 30s
//	flood: write 200 KiB to stdout and to stderr
//	env:   print the child's environment as a JSON array
func TestMain(m *testing.M) {
	switch os.Getenv("STKCLIENT_STUB") {
	case "":
		os.Exit(m.Run())
	case "sleep":
		if p := os.Getenv("STKCLIENT_PIDFILE"); p != "" {
			_ = os.WriteFile(p+".tmp", []byte(fmt.Sprint(os.Getpid())), 0o600)
			_ = os.Rename(p+".tmp", p)
		}
		time.Sleep(30 * time.Second)
	case "flood":
		// stdout is a valid JSON document whose tail exceeds the cap, so only
		// the cap can make it unparseable.
		chunk := strings.Repeat("x", 1024)
		fmt.Fprint(os.Stdout, `{"ok":true,"login":"a","reason":"`)
		for i := 0; i < 200; i++ {
			fmt.Fprint(os.Stdout, chunk)
			fmt.Fprint(os.Stderr, chunk)
		}
		fmt.Fprint(os.Stdout, `"}`)
	case "env":
		_ = json.NewEncoder(os.Stdout).Encode(os.Environ())
	}
	os.Exit(0)
}
