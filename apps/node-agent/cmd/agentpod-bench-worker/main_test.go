package main

import (
	"bytes"
	"runtime"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func TestVersionBindsReleasePlatformAndWorkerProtocol(t *testing.T) {
	prior := version
	version = "v0.0.0-fixture"
	defer func() { version = prior }()
	var out, errOut bytes.Buffer
	if code := entry([]string{"version"}, &out, &errOut); code != 0 {
		t.Fatal(code)
	}
	expected := "agentpod-bench-worker v0.0.0-fixture (" + runtime.GOOS + "/" + runtime.GOARCH + ") " + superbench.WorkerVersion + "\n"
	if out.String() != expected || errOut.Len() != 0 {
		t.Fatal("version identity changed", out.String(), errOut.String())
	}
}
func TestInvalidArgumentsNeverExecuteWorker(t *testing.T) {
	for _, args := range [][]string{nil, {"version", "extra"}} {
		var out, errOut bytes.Buffer
		if code := entry(args, &out, &errOut); code != 2 || out.Len() != 0 || errOut.String() != "one private context directory required\n" {
			t.Fatal(code, out.String(), errOut.String())
		}
	}
}
