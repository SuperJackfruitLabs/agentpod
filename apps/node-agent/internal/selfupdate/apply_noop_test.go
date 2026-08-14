package selfupdate

// Issue #296: Apply must not re-apply a release the node is already running.
//
// The hub-triggered "update" verb calls Apply, and Apply used to download,
// verify and swap unconditionally. On a node already on the latest release
// that is a pointless binary swap followed by a restart — on Fly, a full VM
// reboot that costs the station its uptime and every in-flight session.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// countingUpdateServer is makeUpdateServer plus a download counter, so a test
// can prove that a short-circuited Apply performed no download at all.
func countingUpdateServer(tag string, content []byte, hash string, downloads *int) *httptest.Server {
	asset := assetName(runtime.GOOS, runtime.GOARCH)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/SuperJackfruitLabs/agentpod/releases/latest":
			json.NewEncoder(w).Encode(struct {
				TagName string `json:"tag_name"`
			}{tag})
		case fmt.Sprintf("/SuperJackfruitLabs/agentpod/releases/download/%s/%s", tag, asset):
			*downloads++
			w.Write(content)
		case fmt.Sprintf("/SuperJackfruitLabs/agentpod/releases/download/%s/SHA256SUMS", tag):
			fmt.Fprintf(w, "%s  %s\n", hash, asset)
		default:
			http.NotFound(w, r)
		}
	}))
}

// applyFixture wires a counting release server and a stand-in target binary,
// and returns the target path plus a pointer to the download count.
func applyFixture(t *testing.T, tag string, content []byte) (*httptest.Server, string, *int) {
	t.Helper()
	downloads := 0
	srv := countingUpdateServer(tag, content, binaryHash(content), &downloads)
	t.Cleanup(srv.Close)

	target := filepath.Join(t.TempDir(), "agentpod-node")
	if err := os.WriteFile(target, []byte("RUNNING"), 0o755); err != nil {
		t.Fatal(err)
	}
	return srv, target, &downloads
}

func TestApply_AlreadyCurrentIsANoOp(t *testing.T) {
	const latestTag = "v0.1.25"
	content := []byte("BINARY_NEW")
	srv, target, downloads := applyFixture(t, latestTag, content)

	res, err := Apply(context.Background(), Options{
		CurrentVersion:    latestTag,
		APIBase:           srv.URL,
		DLBase:            srv.URL,
		HTTPClient:        srv.Client(),
		targetPathForTest: target,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Updated {
		t.Error("Updated: got true, want false — the node is already on the latest release")
	}
	if res.LatestTag != latestTag {
		t.Errorf("LatestTag: got %q want %q — the caller still needs the resolved tag", res.LatestTag, latestTag)
	}
	if res.CurrentVersion != latestTag {
		t.Errorf("CurrentVersion: got %q want %q", res.CurrentVersion, latestTag)
	}
	if res.Reason != "already up to date" {
		t.Errorf("Reason: got %q want %q", res.Reason, "already up to date")
	}
	if *downloads != 0 {
		t.Errorf("downloads: got %d want 0 — an up-to-date node must not re-download its own binary", *downloads)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != "RUNNING" {
		t.Errorf("target was swapped (%q) — an up-to-date node's binary must be left alone", got)
	}
}

// The comparison is numeric, not lexical. v0.1.9 sorts AFTER v0.1.24 as a
// string, so a comparator built on string ordering would call this node
// current and strand it two releases behind.
func TestApply_BehindStillApplies(t *testing.T) {
	const latestTag = "v0.1.24"
	content := []byte("BINARY_NEW")
	srv, target, downloads := applyFixture(t, latestTag, content)

	res, err := Apply(context.Background(), Options{
		CurrentVersion:    "v0.1.9", // lexically LATER than v0.1.24, numerically earlier
		APIBase:           srv.URL,
		DLBase:            srv.URL,
		HTTPClient:        srv.Client(),
		targetPathForTest: target,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Updated {
		t.Fatal("Updated: got false, want true — v0.1.9 is behind v0.1.24 and must update")
	}
	if *downloads != 1 {
		t.Errorf("downloads: got %d want 1", *downloads)
	}
	got, _ := os.ReadFile(target)
	if string(got) != string(content) {
		t.Errorf("target: got %q want %q", got, content)
	}
}

// A version string the comparator cannot read (the default build stamps the
// literal "dev", and the pre-`update` agents in the fleet report an empty
// version) must fall through to applying. Refusing to update because the
// version is unreadable would strand exactly the nodes most in need of one.
func TestApply_UnreadableCurrentVersionStillApplies(t *testing.T) {
	const latestTag = "v0.1.25"
	content := []byte("BINARY_NEW")

	for _, current := range []string{"dev", ""} {
		t.Run("current="+current, func(t *testing.T) {
			srv, target, downloads := applyFixture(t, latestTag, content)

			res, err := Apply(context.Background(), Options{
				CurrentVersion:    current,
				APIBase:           srv.URL,
				DLBase:            srv.URL,
				HTTPClient:        srv.Client(),
				targetPathForTest: target,
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !res.Updated {
				t.Error("Updated: got false, want true — an unreadable current version must not suppress the update")
			}
			if *downloads != 1 {
				t.Errorf("downloads: got %d want 1", *downloads)
			}
		})
	}
}

func TestApply_ForceAppliesEvenWhenCurrent(t *testing.T) {
	const latestTag = "v0.1.25"
	content := []byte("BINARY_NEW")
	srv, target, downloads := applyFixture(t, latestTag, content)

	res, err := Apply(context.Background(), Options{
		CurrentVersion:    latestTag,
		Force:             true,
		APIBase:           srv.URL,
		DLBase:            srv.URL,
		HTTPClient:        srv.Client(),
		targetPathForTest: target,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Updated {
		t.Fatal("Updated: got false, want true — Force must re-apply the current release")
	}
	if *downloads != 1 {
		t.Errorf("downloads: got %d want 1", *downloads)
	}
	got, _ := os.ReadFile(target)
	if string(got) != string(content) {
		t.Errorf("target: got %q want %q", got, content)
	}
}
