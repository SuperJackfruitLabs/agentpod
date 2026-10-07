package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The container images compile this binary from source in Dockerfile.base. Without a version
// stamp that build reports "dev", and a runtime's node then reads as "up to date" whatever
// release the fleet is on, so drift in a provisioned runtime was invisible. The stamp is a
// build argument, the same -X main.version the release workflow links in.
func TestBaseImageStampsTheVersion(t *testing.T) {
	b, err := os.ReadFile("../../deploy/Dockerfile.base")
	if err != nil {
		t.Fatal(err)
	}
	// Join continuation lines so a RUN split across lines reads as the one command it is.
	src := strings.ReplaceAll(string(b), "\\\n", " ")
	if !regexp.MustCompile(`(?m)^ARG AGENTPOD_VERSION\b`).MatchString(src) {
		t.Error("Dockerfile.base declares no AGENTPOD_VERSION build argument")
	}
	if !regexp.MustCompile(`(?m)^RUN .*go build .*-X main\.version=\$\{?AGENTPOD_VERSION\}?`).MatchString(src) {
		t.Error("Dockerfile.base's go build does not link AGENTPOD_VERSION into main.version")
	}
}
