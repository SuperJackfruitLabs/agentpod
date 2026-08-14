package selfupdate

import "strings"

import "testing"

// The repository every release URL is built from.
//
// AgentPod moved to the SuperJackfruitLabs organisation on 2026-08-14. Until
// then all three of these URLs named `rakeshgangwar/agentpod`, and they kept
// working only because GitHub redirects a transferred repository's requests.
//
// That is a thin thread to hang a fleet's self-update on. A redirect is not a
// contract: it stops the day the old owner name is reclaimed by anyone, and
// what breaks then is every node's ability to take a new binary — discovered,
// as issue #295 found the last version drift, only by noticing the fleet is
// months behind.
//
// One constant, asserted here, so a future move is a one-line change and a
// failing test rather than a silent dependence on redirection.
func TestReleaseURLsNameTheCurrentRepository(t *testing.T) {
	if releaseRepo != "SuperJackfruitLabs/agentpod" {
		t.Fatalf("releaseRepo = %q, want SuperJackfruitLabs/agentpod", releaseRepo)
	}
}

func TestReleaseURLBuildersUseTheConstant(t *testing.T) {
	// Guard the guard: a constant nothing reads would pass the test above while
	// the URLs kept naming the old owner.
	for _, tc := range []struct {
		name string
		got  string
	}{
		{"latest tag", latestTagURL("https://api.github.com")},
		{"asset", assetDownloadURL("https://github.com", "v0.1.26", "agentpod-node-linux-amd64")},
		{"checksums", checksumsURL("https://github.com", "v0.1.26")},
	} {
		if !strings.Contains(tc.got, releaseRepo) {
			t.Errorf("%s URL %q does not contain %q", tc.name, tc.got, releaseRepo)
		}
		if strings.Contains(tc.got, "rakeshgangwar") {
			t.Errorf("%s URL %q still names the pre-transfer owner", tc.name, tc.got)
		}
	}
}
