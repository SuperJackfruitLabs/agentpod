package fleetcli

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The forge-api help text and the reference agree: every verb the usage lists is a reference
// entry, and every reference entry is in the usage.
func TestForgeAPIHelpAndReferenceAgree(t *testing.T) {
	inRef := map[string]bool{}
	for _, c := range Reference.Commands {
		if v, ok := strings.CutPrefix(c.Path, "stations forge-api "); ok {
			inRef[v] = true
		}
	}
	inHelp := map[string]bool{}
	for _, line := range strings.Split(ForgeAPIUsage, "\n") {
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "   ") {
			inHelp[strings.Fields(line)[0]] = true
		}
	}
	if len(inRef) != 8 || len(inHelp) != len(inRef) {
		t.Fatalf("reference %v, help %v", inRef, inHelp)
	}
	for v := range inRef {
		if !inHelp[v] {
			t.Errorf("%s is in the reference but not the help", v)
		}
	}
	if !strings.Contains(StationsUsage, "forge-api") {
		t.Error("fleet stations --help does not mention forge-api")
	}
}

func TestEnvelopeGuard(t *testing.T) {
	if err := CheckEnvelope("stk-handover-v1:abc"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "abc", "ghp_xxx"} {
		if err := CheckEnvelope(bad); err == nil || strings.Contains(err.Error(), bad+"x") {
			t.Errorf("%q accepted or error echoes it: %v", bad, err)
		}
	}
}

// The CLI's envelope cap is the contract's FORGE_API_SEALED_MAX, the one value the hub uses.
func TestForgeSealedMaxMatchesTheContract(t *testing.T) {
	src, err := os.ReadFile("../../../../packages/contract/src/forge-api.ts")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`export const FORGE_API_SEALED_MAX = (\d+);`).FindSubmatch(src)
	if m == nil {
		t.Fatal("packages/contract/src/forge-api.ts does not export FORGE_API_SEALED_MAX as a literal")
	}
	if want := string(m[1]); want != strconv.Itoa(ForgeSealedMax) {
		t.Fatalf("forgeSealedMax = %d, contract FORGE_API_SEALED_MAX = %s", ForgeSealedMax, want)
	}
}
