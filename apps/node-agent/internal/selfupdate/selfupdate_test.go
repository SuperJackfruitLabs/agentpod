package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Steps 1–2: parseSHA256SUMS
// ---------------------------------------------------------------------------

func TestParseSHA256SUMS(t *testing.T) {
	t.Run("found", func(t *testing.T) {
		data := []byte("abc123  agentpod-node-linux-amd64\ndef456  other\n")
		got, err := parseSHA256SUMS(data, "agentpod-node-linux-amd64")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "abc123" {
			t.Errorf("got %q want abc123", got)
		}
	})
	t.Run("missing_asset", func(t *testing.T) {
		data := []byte("abc123  other-binary\n")
		_, err := parseSHA256SUMS(data, "agentpod-node-linux-amd64")
		if err == nil {
			t.Fatal("expected error for missing asset, got nil")
		}
	})
	t.Run("malformed_line", func(t *testing.T) {
		data := []byte("onlyoneword\n")
		_, err := parseSHA256SUMS(data, "agentpod-node-linux-amd64")
		if err == nil {
			t.Fatal("expected error for malformed line, got nil")
		}
	})
	t.Run("empty", func(t *testing.T) {
		_, err := parseSHA256SUMS([]byte(""), "agentpod-node-linux-amd64")
		if err == nil {
			t.Fatal("expected error for empty data, got nil")
		}
	})
}

// ---------------------------------------------------------------------------
// Steps 3–4: assetName + LatestTag
// ---------------------------------------------------------------------------

func TestAssetName(t *testing.T) {
	got := assetName("linux", "amd64")
	if got != "agentpod-node-linux-amd64" {
		t.Errorf("got %q want agentpod-node-linux-amd64", got)
	}
	got2 := assetName("darwin", "arm64")
	if got2 != "agentpod-node-darwin-arm64" {
		t.Errorf("got %q want agentpod-node-darwin-arm64", got2)
	}
}

func TestLatestTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/rakeshgangwar/agentpod/releases/latest" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"tag_name":"v0.1.2"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	tag, err := LatestTag(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tag != "v0.1.2" {
		t.Errorf("got %q want v0.1.2", tag)
	}
}

func TestLatestTag_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := LatestTag(context.Background(), srv.Client(), srv.URL)
	if err == nil {
		t.Fatal("expected error on non-200 response")
	}
}

// ---------------------------------------------------------------------------
// Steps 5–6: downloadAndVerify
// ---------------------------------------------------------------------------

func binaryHash(data []byte) string {
	h := sha256.New()
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

func TestDownloadAndVerify(t *testing.T) {
	const tag = "v0.1.2"
	const asset = "agentpod-node-linux-amd64"
	content := []byte("BINARY")
	correctHash := binaryHash(content)

	// Server with correct SHA256SUMS
	goodSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assetPath := "/rakeshgangwar/agentpod/releases/download/" + tag + "/" + asset
		sumsPath := "/rakeshgangwar/agentpod/releases/download/" + tag + "/SHA256SUMS"
		switch r.URL.Path {
		case assetPath:
			w.Write(content)
		case sumsPath:
			fmt.Fprintf(w, "%s  %s\n", correctHash, asset)
		default:
			http.NotFound(w, r)
		}
	}))
	defer goodSrv.Close()

	t.Run("match", func(t *testing.T) {
		destDir := t.TempDir()
		tmpPath, err := downloadAndVerify(context.Background(), goodSrv.Client(), goodSrv.URL, tag, asset, destDir)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		got, err := os.ReadFile(tmpPath)
		if err != nil {
			t.Fatalf("read tmpPath: %v", err)
		}
		if string(got) != string(content) {
			t.Errorf("content mismatch: got %q want %q", got, content)
		}
	})

	t.Run("mismatch_leaves_no_file", func(t *testing.T) {
		// Server with wrong hash in SHA256SUMS
		badSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assetPath := "/rakeshgangwar/agentpod/releases/download/" + tag + "/" + asset
			sumsPath := "/rakeshgangwar/agentpod/releases/download/" + tag + "/SHA256SUMS"
			switch r.URL.Path {
			case assetPath:
				w.Write(content)
			case sumsPath:
				fmt.Fprintf(w, "%s  %s\n", "wronghashwronghashwronghash", asset)
			default:
				http.NotFound(w, r)
			}
		}))
		defer badSrv.Close()

		destDir := t.TempDir()
		_, err := downloadAndVerify(context.Background(), badSrv.Client(), badSrv.URL, tag, asset, destDir)
		if err == nil {
			t.Fatal("expected error on hash mismatch, got nil")
		}
		// No leftover .tmp files
		entries, readErr := os.ReadDir(destDir)
		if readErr != nil {
			t.Fatalf("ReadDir: %v", readErr)
		}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".tmp") {
				t.Errorf("leftover temp file: %s", e.Name())
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Steps 7–8: swapBinary
// ---------------------------------------------------------------------------

func TestSwapBinary(t *testing.T) {
	t.Run("swap_and_bak", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "agentpod-node")

		// Write old binary
		if err := os.WriteFile(target, []byte("OLD"), 0o755); err != nil {
			t.Fatal(err)
		}

		// Create temp file with new content
		tmp, err := os.CreateTemp(dir, "agentpod-node-*.tmp")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tmp.Write([]byte("NEW")); err != nil {
			t.Fatal(err)
		}
		tmp.Close()
		tmpName := tmp.Name()

		if err := swapBinary(target, tmpName); err != nil {
			t.Fatalf("swapBinary: %v", err)
		}

		// Target should now contain "NEW"
		got, err := os.ReadFile(target)
		if err != nil {
			t.Fatalf("read target: %v", err)
		}
		if string(got) != "NEW" {
			t.Errorf("target: got %q want NEW", got)
		}

		// .bak should contain "OLD"
		bak, err := os.ReadFile(target + ".bak")
		if err != nil {
			t.Fatalf("read .bak: %v", err)
		}
		if string(bak) != "OLD" {
			t.Errorf(".bak: got %q want OLD", bak)
		}

		// Mode should be 0755
		info, err := os.Stat(target)
		if err != nil {
			t.Fatalf("stat target: %v", err)
		}
		if info.Mode()&0o777 != 0o755 {
			t.Errorf("mode: got %o want 755", info.Mode()&0o777)
		}
	})
}

// ---------------------------------------------------------------------------
// Steps 9–10: restartService
// ---------------------------------------------------------------------------

func TestRestartService(t *testing.T) {
	t.Run("user_unit_active", func(t *testing.T) {
		var calls [][]string
		run := func(name string, args ...string) error {
			call := append([]string{name}, args...)
			calls = append(calls, call)
			// All calls succeed
			return nil
		}
		if err := restartService("linux", run); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		// Expected: is-active probe (succeeds) → user restart
		if len(calls) != 2 {
			t.Fatalf("expected 2 calls, got %d: %v", len(calls), calls)
		}
		wantProbe := []string{"systemctl", "--user", "is-active", "agentpod-node"}
		wantRestart := []string{"systemctl", "--user", "restart", "agentpod-node"}
		if !reflect.DeepEqual(calls[0], wantProbe) {
			t.Errorf("call[0]: got %v want %v", calls[0], wantProbe)
		}
		if !reflect.DeepEqual(calls[1], wantRestart) {
			t.Errorf("call[1]: got %v want %v", calls[1], wantRestart)
		}
	})

	t.Run("system_unit", func(t *testing.T) {
		var calls [][]string
		run := func(name string, args ...string) error {
			call := append([]string{name}, args...)
			calls = append(calls, call)
			// First call (is-active) fails → not a user unit
			if len(calls) == 1 {
				return fmt.Errorf("unit not active")
			}
			return nil
		}
		if err := restartService("linux", run); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(calls) != 2 {
			t.Fatalf("expected 2 calls, got %d: %v", len(calls), calls)
		}
		wantRestart := []string{"systemctl", "restart", "agentpod-node"}
		if !reflect.DeepEqual(calls[1], wantRestart) {
			t.Errorf("call[1]: got %v want %v", calls[1], wantRestart)
		}
	})

	t.Run("restart_fails_returns_sentinel", func(t *testing.T) {
		run := func(name string, args ...string) error {
			// is-active fails, then restart also fails
			return fmt.Errorf("systemctl error")
		}
		err := restartService("linux", run)
		if err == nil {
			t.Fatal("expected error when restart fails")
		}
		// Should wrap ErrRestartFailed
		var found bool
		e := err
		for e != nil {
			if e == ErrRestartFailed {
				found = true
				break
			}
			// unwrap one level
			type unwrapper interface{ Unwrap() error }
			if u, ok := e.(unwrapper); ok {
				e = u.Unwrap()
			} else {
				break
			}
		}
		if !found {
			// fmt.Errorf with %w wraps; check with errors.Is
			// We'll check the string contains expected sentinel
			if !strings.Contains(err.Error(), "restart failed") {
				t.Errorf("error %q does not reference restart failed", err.Error())
			}
		}
	})
}

func TestRestartServiceDarwinUsesLaunchctlKickstart(t *testing.T) {
	var calls [][]string
	run := func(name string, args ...string) error {
		calls = append(calls, append([]string{name}, args...))
		return nil
	}

	if err := restartService("darwin", run); err != nil {
		t.Fatalf("restartService: %v", err)
	}

	want := []string{"launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/dev.agentpod.node", os.Getuid())}
	if len(calls) != 1 || !reflect.DeepEqual(calls[0], want) {
		t.Fatalf("calls = %v, want exactly [%v]", calls, want)
	}
}

func TestRestartServiceDarwinFailureWrapsErrRestartFailed(t *testing.T) {
	run := func(name string, args ...string) error { return errors.New("no such service") }
	err := restartService("darwin", run)
	if !errors.Is(err, ErrRestartFailed) {
		t.Fatalf("err = %v, want ErrRestartFailed", err)
	}
}

// ---------------------------------------------------------------------------
// Apply: resolve latest → download → verify → swap, NO restart
// ---------------------------------------------------------------------------

func TestApply(t *testing.T) {
	const latestTag = "v0.1.3"
	content := []byte("BINARY_APPLY")
	correctHash := binaryHash(content)

	srv := makeUpdateServer(latestTag, content, correctHash)
	defer srv.Close()

	dir := t.TempDir()
	target := filepath.Join(dir, "agentpod-node")
	if err := os.WriteFile(target, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	var runCalled bool
	run := func(name string, args ...string) error {
		runCalled = true
		return nil
	}

	res, err := Apply(context.Background(), Options{
		CurrentVersion:    "v0.1.1",
		APIBase:           srv.URL,
		DLBase:            srv.URL,
		HTTPClient:        srv.Client(),
		RunCommand:        run,
		targetPathForTest: target,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Updated {
		t.Error("Updated should be true")
	}
	if res.LatestTag != latestTag {
		t.Errorf("LatestTag: got %q want %q", res.LatestTag, latestTag)
	}
	// Target should now contain the new binary.
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("target: got %q want %q", got, content)
	}
	// Apply must NEVER invoke the restart runner.
	if runCalled {
		t.Error("Apply must not invoke the restart RunCommand")
	}
}

// ---------------------------------------------------------------------------
// Steps 11–12: Update orchestration
// ---------------------------------------------------------------------------

func makeUpdateServer(tag string, content []byte, hash string) *httptest.Server {
	asset := assetName(runtime.GOOS, runtime.GOARCH)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/rakeshgangwar/agentpod/releases/latest":
			json.NewEncoder(w).Encode(struct {
				TagName string `json:"tag_name"`
			}{tag})
		case fmt.Sprintf("/rakeshgangwar/agentpod/releases/download/%s/%s", tag, asset):
			w.Write(content)
		case fmt.Sprintf("/rakeshgangwar/agentpod/releases/download/%s/SHA256SUMS", tag):
			fmt.Fprintf(w, "%s  %s\n", hash, asset)
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestUpdate(t *testing.T) {
	const latestTag = "v0.1.2"
	content := []byte("BINARY")
	correctHash := binaryHash(content)

	t.Run("already_up_to_date", func(t *testing.T) {
		srv := makeUpdateServer(latestTag, content, correctHash)
		defer srv.Close()

		res, err := Update(context.Background(), Options{
			CurrentVersion: latestTag,
			APIBase:        srv.URL,
			DLBase:         srv.URL,
			HTTPClient:     srv.Client(),
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.Updated {
			t.Error("Updated should be false when already at latest")
		}
		if res.Reason != "already up to date" {
			t.Errorf("Reason: got %q want %q", res.Reason, "already up to date")
		}
		if res.LatestTag != latestTag {
			t.Errorf("LatestTag: got %q want %q", res.LatestTag, latestTag)
		}
	})

	t.Run("update_path", func(t *testing.T) {
		srv := makeUpdateServer(latestTag, content, correctHash)
		defer srv.Close()

		dir := t.TempDir()
		target := filepath.Join(dir, "agentpod-node")
		if err := os.WriteFile(target, []byte("OLD"), 0o755); err != nil {
			t.Fatal(err)
		}

		var runCalls [][]string
		run := func(name string, args ...string) error {
			call := append([]string{name}, args...)
			runCalls = append(runCalls, call)
			// is-active probe succeeds → user unit path
			if len(runCalls) == 1 {
				return nil
			}
			return nil
		}

		res, err := Update(context.Background(), Options{
			CurrentVersion:    "v0.1.1",
			APIBase:           srv.URL,
			DLBase:            srv.URL,
			HTTPClient:        srv.Client(),
			RunCommand:        run,
			targetPathForTest: target,
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !res.Updated {
			t.Error("Updated should be true")
		}
		if res.LatestTag != latestTag {
			t.Errorf("LatestTag: got %q want %q", res.LatestTag, latestTag)
		}
		// Target should now contain "BINARY"
		got, err := os.ReadFile(target)
		if err != nil {
			t.Fatalf("read target: %v", err)
		}
		if string(got) != string(content) {
			t.Errorf("target: got %q want %q", got, content)
		}
		// Restart was called. Update() passes the real runtime.GOOS through to
		// restartService, so the exact call count is platform-dependent (linux:
		// is-active probe + restart = 2; darwin: single launchctl kickstart = 1).
		// The systemd- and launchd-specific call sequences are covered in detail
		// by TestRestartService and TestRestartServiceDarwin*; here we only
		// assert that Update() actually attempted a restart.
		if len(runCalls) < 1 {
			t.Errorf("expected restart calls, got %d", len(runCalls))
		}
	})

	t.Run("check_only_no_swap", func(t *testing.T) {
		srv := makeUpdateServer(latestTag, content, correctHash)
		defer srv.Close()

		dir := t.TempDir()
		target := filepath.Join(dir, "agentpod-node")
		if err := os.WriteFile(target, []byte("OLD"), 0o755); err != nil {
			t.Fatal(err)
		}

		res, err := Update(context.Background(), Options{
			CurrentVersion:    "v0.1.1",
			CheckOnly:         true,
			APIBase:           srv.URL,
			DLBase:            srv.URL,
			HTTPClient:        srv.Client(),
			targetPathForTest: target,
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.Updated {
			t.Error("Updated should be false in check-only mode")
		}
		if res.LatestTag != latestTag {
			t.Errorf("LatestTag: got %q want %q", res.LatestTag, latestTag)
		}
		// Target should be unchanged
		got, err := os.ReadFile(target)
		if err != nil {
			t.Fatalf("read target: %v", err)
		}
		if string(got) != "OLD" {
			t.Errorf("check-only mode modified target: got %q", got)
		}
	})

	t.Run("force_same_version", func(t *testing.T) {
		srv := makeUpdateServer(latestTag, content, correctHash)
		defer srv.Close()

		dir := t.TempDir()
		target := filepath.Join(dir, "agentpod-node")
		if err := os.WriteFile(target, []byte("OLD"), 0o755); err != nil {
			t.Fatal(err)
		}

		run := func(name string, args ...string) error { return nil }

		res, err := Update(context.Background(), Options{
			CurrentVersion:    latestTag,
			Force:             true,
			APIBase:           srv.URL,
			DLBase:            srv.URL,
			HTTPClient:        srv.Client(),
			RunCommand:        run,
			targetPathForTest: target,
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !res.Updated {
			t.Error("Updated should be true when Force=true even if versions match")
		}
		got, err := os.ReadFile(target)
		if err != nil {
			t.Fatalf("read target: %v", err)
		}
		if string(got) != string(content) {
			t.Errorf("target: got %q want %q", got, content)
		}
	})
}
