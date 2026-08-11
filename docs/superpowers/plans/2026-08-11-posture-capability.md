# `posture` Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apn scan`'s findings correct, then make them visible across the fleet from the console instead of one SSH session at a time.

**Architecture:** Fix three correctness bugs in `internal/posture` first (wrong credential paths, no per-station scanning, file-mode-is-not-exposure), then expose the corrected scan as a node-level `posture.scan` verb gated on a new node-capability mechanism carried in the existing `hello` handshake.

**Tech Stack:** Go 1.26 (node-agent), zod 4 (`packages/contract`), Bun + Hono + Drizzle (hub), Svelte 5 runes + bits-ui (console).

**Spec:** `docs/superpowers/specs/2026-08-11-posture-capability-design.md`

## Global Constraints

- **Bugs 1 and 3 must land in the same commit-range and never ship apart.** Correcting the paths without correcting reachability turns a correctly-secured molt-bot into 15 false criticals and a grade of F.
- **Never read credential file contents.** The scan reports paths and modes only. Telling someone their keys are exposed must not require reading their keys.
- **Absence is silent; unreadable is `unknown`.** A missing path produces no finding. A path that exists but cannot be stat'd is `StatusUnknown`, never `pass`.
- **`StatusUnknown` never improves or worsens a grade.** Existing behaviour in `Grade()`; do not change it.
- Every corrected path entry carries a comment naming the machine it was verified on and the date. Assumption is what produced bug 1.
- Observe-only: no stored posture history, no fleet roll-up, no remediation from the console.
- POSIX only — the reachability walk assumes Unix mode bits. No Windows.
- TDD: every task writes its failing test first.
- Branch: `posture-capability` off `main`. Single PR.

## Ground truth (verified 2026-08-11)

Referenced by several tasks; recorded here once.

**molt-bot** (Hermes, 15 profiles, reached at `46.225.24.70` — Tailscale showed offline, public SSH worked):
```
/root/.hermes/auth.json          600
/root/.hermes/config.yaml        600
/root/.hermes/.env               600
/root/.hermes/profiles/          755
/root/.hermes/profiles/<name>/   700
/root/.hermes/profiles/<name>/auth.json    600
/root/.hermes/profiles/<name>/.env         600
/root/.hermes/profiles/<name>/config.yaml  644   ← unreachable: /root is 700
```

**superchotu** (OpenClaw, 12 agents):
```
~/.openclaw/.env                        600
~/.openclaw/gateway.systemd.env         600
~/.openclaw/credentials/*.json          600
~/.openclaw/agents/                     700
~/.openclaw/agents/<name>/              775   ← group-writable
~/.openclaw/agents/<name>/agent/        700
~/.openclaw/agents/<name>/agent/auth.json          600
~/.openclaw/agents/<name>/agent/auth-profiles.json 600
~/.openclaw/agents/<name>/agent/auth-state.json    600
```

**This Mac:** `~/.openclaw/openclaw.json` 600; `~/.claude.json` 600; `~/.codex/auth.json` 600; `~/.codex/config.toml` 600; `~/.local/share/opencode/auth.json` 600. `~/.claude/.credentials.json` absent (macOS Keychain).

## File Structure

**`apps/node-agent/internal/posture`**
- `reach.go` *(create)* — effective reachability. One responsibility: can another user actually get to this path.
- `creds.go` *(modify)* — corrected path map, glob expansion, reachability-aware findings.
- `station.go` *(create)* — per-station credential discovery for composite harnesses.
- `dirs.go` *(create)* — config directory mode checks.
- `scan.go` *(modify)* — compose the new checks into `Scan`.

**`packages/contract`**
- `src/posture.ts` *(create)* — `PostureFinding`, `PostureReport`.
- `src/gateway.ts` *(modify)* — `HelloMsg.capabilities`.
- `src/node.ts` *(modify)* — `NodeSummary.capabilities`.
- `src/protocol.ts` *(modify)* — `posture.scan` params/results.
- `src/index.ts` *(modify)* — re-export.
- `scripts/emit-go-fixtures.ts` *(modify)* — hello fixture gains capabilities.

**`apps/node-agent`**
- `internal/gateway/posture.go` *(create)* — the verb handler.
- `internal/gateway/client.go:167` *(modify)* — hello carries capabilities.
- `cmd/agentpod-node/run.go` *(modify)* — wire the handler.

**`apps/hub`**
- `src/db/schema/nodes.ts` *(modify)* — `capabilities` jsonb.
- `src/services/node-registry.ts` *(modify)* — persist them.
- `src/routes/gateway.ts:105` *(modify)* — read them off `hello`.
- `src/routes/node-posture.ts` *(create)* — the route.
- `src/index.ts` *(modify)* — mount.

**`apps/console`**
- `src/lib/api/client.ts` *(modify)* — `nodePosture`.
- `src/lib/components/fleet/PosturePanel.svelte` *(create)*.
- `src/routes/nodes/[id]/+page.svelte` *(modify)* — render it, gated.
- `src/lib/components/stations/PostureBanner.svelte` *(create)*.
- `src/routes/nodes/[id]/stations/[stationId]/+page.svelte` *(modify)* — render the banner.

---

## Task 1: Effective reachability

The load-bearing correctness fix. Written first because Task 2 depends on it and must not ship without it.

**Files:**
- Create: `apps/node-agent/internal/posture/reach.go`
- Create: `apps/node-agent/internal/posture/reach_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Exposure struct { World bool; Group bool }`
  - `func (e Exposure) Any() bool`
  - `func EffectiveExposure(path string) (Exposure, error)`

- [ ] **Step 1: Write the failing test**

Create `apps/node-agent/internal/posture/reach_test.go`:

```go
package posture

import (
	"os"
	"path/filepath"
	"testing"
)

// mkChain builds dir/file with the given modes and returns the file path.
// Modes are applied deepest-last so a restrictive parent does not block setup.
func mkChain(t *testing.T, dirModes []os.FileMode, fileMode os.FileMode) string {
	t.Helper()
	root := t.TempDir()
	// The temp root itself must be traversable, or every case looks unreachable.
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	cur := root
	var made []string
	for i := range dirModes {
		cur = filepath.Join(cur, "d"+string(rune('a'+i)))
		if err := os.Mkdir(cur, 0o755); err != nil {
			t.Fatal(err)
		}
		made = append(made, cur)
	}
	file := filepath.Join(cur, "creds.json")
	if err := os.WriteFile(file, []byte("{}"), fileMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, fileMode); err != nil {
		t.Fatal(err)
	}
	// Apply directory modes deepest-first so we can still walk down during setup.
	for i := len(made) - 1; i >= 0; i-- {
		if err := os.Chmod(made[i], dirModes[i]); err != nil {
			t.Fatal(err)
		}
	}
	// Restore permissive modes at cleanup or TempDir removal fails.
	t.Cleanup(func() {
		for _, d := range made {
			_ = os.Chmod(d, 0o755)
		}
	})
	return file
}

func TestExposedWhenEveryAncestorIsTraversable(t *testing.T) {
	file := mkChain(t, []os.FileMode{0o755, 0o755}, 0o644)
	got, err := EffectiveExposure(file)
	if err != nil {
		t.Fatalf("EffectiveExposure: %v", err)
	}
	if !got.World {
		t.Error("a 644 file under traversable dirs is world-readable")
	}
}

func TestNotExposedWhenAnAncestorBlocksTraversal(t *testing.T) {
	// The molt-bot case: /root is 700, so a 644 config.yaml several levels down
	// is unreachable. Reporting it would be a false critical on a correctly
	// secured box — 15 of them, one per Hermes profile.
	file := mkChain(t, []os.FileMode{0o700, 0o755}, 0o644)
	got, err := EffectiveExposure(file)
	if err != nil {
		t.Fatalf("EffectiveExposure: %v", err)
	}
	if got.World {
		t.Error("a 700 ancestor makes the file unreachable; this must not be reported")
	}
	if got.Any() {
		t.Error("neither world nor group can traverse a 700 ancestor")
	}
}

func TestOwnerOnlyFileIsNeverExposed(t *testing.T) {
	file := mkChain(t, []os.FileMode{0o755, 0o755}, 0o600)
	got, _ := EffectiveExposure(file)
	if got.Any() {
		t.Errorf("a 600 file is not exposed however open its parents: %+v", got)
	}
}

func TestGroupAndWorldAreTrackedSeparately(t *testing.T) {
	// A file can be group-exposed without being world-exposed, and the two
	// carry different severities and different remedies.
	file := mkChain(t, []os.FileMode{0o750, 0o755}, 0o640)
	got, err := EffectiveExposure(file)
	if err != nil {
		t.Fatalf("EffectiveExposure: %v", err)
	}
	if got.World {
		t.Error("the 750 ancestor denies o+x, so the world cannot reach it")
	}
	if !got.Group {
		t.Error("the group can traverse 750 and read 640")
	}
}

func TestGroupBlockedByAnAncestorDenyingGroupExec(t *testing.T) {
	file := mkChain(t, []os.FileMode{0o700, 0o755}, 0o640)
	got, _ := EffectiveExposure(file)
	if got.Group {
		t.Error("a 700 ancestor denies g+x, so the group cannot reach it either")
	}
}

func TestMissingPathIsAnError(t *testing.T) {
	// Callers must be able to tell "not there" from "not exposed".
	if _, err := EffectiveExposure(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("want an error for a missing path")
	}
}

func TestAnyIsFalseForNoExposure(t *testing.T) {
	if (Exposure{}).Any() {
		t.Error("zero Exposure must not report exposure")
	}
	if !(Exposure{Group: true}).Any() {
		t.Error("group exposure counts")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/posture/ -run TestExposed
```

Expected: build failure — `undefined: EffectiveExposure`.

- [ ] **Step 3: Implement it**

Create `apps/node-agent/internal/posture/reach.go`:

```go
package posture

import (
	"io/fs"
	"os"
	"path/filepath"
)

// Exposure says who, other than the owner, can actually read a path.
//
// "Actually" is the whole point: a file's own mode bits are necessary but not
// sufficient. A 644 file inside a 700 directory is unreachable by anyone else,
// and reporting it would be a false alarm — the failure mode this package's
// doc comment forbids as loudly as a false pass.
type Exposure struct {
	World bool
	Group bool
}

// Any reports whether anyone other than the owner can read the path.
func (e Exposure) Any() bool { return e.World || e.Group }

// EffectiveExposure reports who can genuinely reach and read path.
//
// Two conditions must both hold for a class (group or other):
//
//  1. the file itself grants read to that class, and
//  2. every ancestor directory grants execute (traverse) to that class.
//
// Verified against molt-bot 2026-08-11, where
// /root/.hermes/profiles/<name>/config.yaml is mode 644 under a 700 /root:
// world-readable by mode, unreachable in fact.
func EffectiveExposure(path string) (Exposure, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Exposure{}, err
	}

	perm := info.Mode().Perm()
	e := Exposure{
		World: perm&0o004 != 0,
		Group: perm&0o040 != 0,
	}
	if !e.Any() {
		return e, nil // owner-only: no ancestor can make it worse
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		return Exposure{}, err
	}

	// Walk up to the root. A single non-traversable ancestor is enough to make
	// the file unreachable for that class.
	dir := filepath.Dir(abs)
	for {
		di, derr := os.Stat(dir)
		if derr != nil {
			// An ancestor we cannot stat cannot be shown to be traversable.
			// Treating it as open would invent exposure we have not seen.
			return Exposure{}, derr
		}
		if !traversable(di.Mode().Perm(), 0o001) {
			e.World = false
		}
		if !traversable(di.Mode().Perm(), 0o010) {
			e.Group = false
		}
		if !e.Any() {
			return e, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return e, nil // reached the root
		}
		dir = parent
	}
}

func traversable(perm fs.FileMode, bit fs.FileMode) bool {
	return perm&bit != 0
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/node-agent && go test -race ./internal/posture/ -run "TestExposed|TestNotExposed|TestOwnerOnly|TestGroup|TestMissingPath|TestAny"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/posture/reach.go apps/node-agent/internal/posture/reach_test.go
git commit -m "feat(posture): effective reachability — file mode alone is not exposure"
```

---

## Task 2: Correct the credential path map

**This task must not be committed without Task 1.** Together they are the fix; alone this one produces false criticals.

**Files:**
- Modify: `apps/node-agent/internal/posture/creds.go:20-111`
- Modify: `apps/node-agent/internal/posture/posture_test.go` (the existing credential tests)

**Interfaces:**
- Consumes: `EffectiveExposure`, `Exposure` from Task 1.
- Produces: `CredentialPaths` (corrected, glob-capable); `CheckCredentialFiles(home string, harnesses []string) []Finding` (unchanged signature); `expandCredentialPaths(home, rel string) []string`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/node-agent/internal/posture/posture_test.go`:

```go
// ─── corrected paths ────────────────────────────────────────────────────────

// The bug this pins: the shipped map named files that do not exist for hermes
// and openclaw, so `apn scan` graded machines A having opened nothing. Verified
// against molt-bot and superchotu on 2026-08-11.
func TestCredentialPathsMatchRealHarnessLayouts(t *testing.T) {
	want := map[string][]string{
		"hermes":   {".hermes/config.yaml", ".hermes/auth.json", ".hermes/.env"},
		"openclaw": {".openclaw/openclaw.json", ".openclaw/.env", ".openclaw/gateway.systemd.env", ".openclaw/credentials/*.json"},
	}
	for harness, paths := range want {
		got := CredentialPaths[harness]
		for _, p := range paths {
			if !slices.Contains(got, p) {
				t.Errorf("%s: missing %q from %v", harness, p, got)
			}
		}
	}
}

func TestCredentialPathsDropTheFilesThatNeverExisted(t *testing.T) {
	// Keeping a path that matches nothing is not harmless: it is what made the
	// scan look thorough while checking nothing.
	gone := map[string][]string{
		"hermes":   {".hermes/config.json", ".hermes/credentials.json"},
		"openclaw": {".openclaw/config.json", ".openclaw/credentials.json", ".openclaw/gateway.json"},
	}
	for harness, paths := range gone {
		for _, p := range paths {
			if slices.Contains(CredentialPaths[harness], p) {
				t.Errorf("%s: %q does not exist on any real machine and must be removed", harness, p)
			}
		}
	}
}

func TestCredentialGlobsExpand(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".openclaw", "credentials")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"telegram-pairing.json", "gateway-pairing.json", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	got := expandCredentialPaths(home, ".openclaw/credentials/*.json")
	if len(got) != 2 {
		t.Fatalf("expanded to %d paths, want 2 (json only): %v", len(got), got)
	}
}

func TestCredentialGlobMatchingNothingIsSilent(t *testing.T) {
	// Same rule as an absent literal: absence is not a finding.
	got := expandCredentialPaths(t.TempDir(), ".openclaw/credentials/*.json")
	if len(got) != 0 {
		t.Errorf("want no paths, got %v", got)
	}
}

func TestUnreachableFileIsNotReportedAsExposed(t *testing.T) {
	// The molt-bot case end-to-end: a 644 credential file under a 700 ancestor
	// is not exposed and must not be a finding. Without this, correcting the
	// paths turns a secured box into 15 false criticals.
	home := t.TempDir()
	hermes := filepath.Join(home, ".hermes")
	if err := os.MkdirAll(hermes, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(hermes, "auth.json")
	if err := os.WriteFile(p, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(hermes, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(hermes, 0o755) })

	for _, f := range CheckCredentialFiles(home, []string{"hermes"}) {
		if f.Status == StatusFail {
			t.Errorf("unreachable file reported as exposed: %+v", f)
		}
	}
}

func TestReachableWorldReadableFileIsStillCritical(t *testing.T) {
	// The guard must not swallow real findings.
	home := t.TempDir()
	hermes := filepath.Join(home, ".hermes")
	if err := os.MkdirAll(hermes, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hermes, "auth.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	var found bool
	for _, f := range CheckCredentialFiles(home, []string{"hermes"}) {
		if f.Status == StatusFail && f.Severity == SeverityCritical {
			found = true
		}
	}
	if !found {
		t.Error("a genuinely reachable world-readable credential file must be critical")
	}
}
```

Add `"slices"`, `"os"` and `"path/filepath"` to that file's imports if absent.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/node-agent && go test ./internal/posture/ -run "TestCredential|TestUnreachable|TestReachable"
```

Expected: FAIL — the path assertions fail against the shipped map, and `expandCredentialPaths` is undefined.

- [ ] **Step 3: Replace the path map**

In `apps/node-agent/internal/posture/creds.go`, replace the `CredentialPaths` block:

```go
// CredentialPaths are the files each harness keeps secrets in, relative to the
// user's home directory. Entries may be globs.
//
// Every entry below was checked against a running machine on 2026-08-11, and
// the date matters: the first version of this map was written from assumption
// and named five files that exist on no machine we own, so `apn scan` reported
// "nothing world-readable" for hermes and openclaw having opened nothing.
// Adding a harness means adding a line here AND verifying it on a real host.
var CredentialPaths = map[string][]string{
	// superchotu 2026-08-11: .env holds the model keys, referenced by name from
	// each agent's auth-profiles.json. gateway.systemd.env holds the unit's env.
	// This Mac 2026-08-11: the main config is openclaw.json, not config.json.
	"openclaw": {
		".openclaw/openclaw.json",
		".openclaw/.env",
		".openclaw/gateway.systemd.env",
		".openclaw/credentials/*.json",
	},

	// molt-bot 2026-08-11: config.yaml (not .json), auth.json (not
	// credentials.json), plus .env. All three were mode 600.
	"hermes": {
		".hermes/config.yaml",
		".hermes/auth.json",
		".hermes/.env",
	},

	// This Mac 2026-08-11: .claude.json present; .claude/.credentials.json
	// absent because macOS keeps that token in the Keychain. Kept because it is
	// present on Linux installs — an absent path is silent, so it costs nothing.
	"claude-code": {".claude/.credentials.json", ".claude.json"},

	// This Mac 2026-08-11: both present, both 600.
	"codex": {".codex/auth.json", ".codex/config.toml"},

	// This Mac 2026-08-11: present, 600.
	"opencode": {".local/share/opencode/auth.json"},
}
```

- [ ] **Step 4: Add glob expansion and use reachability**

Still in `creds.go`, add the helper and rewrite the loop body of `CheckCredentialFiles`:

```go
// expandCredentialPaths turns one map entry into concrete absolute paths.
//
// A glob that matches nothing behaves exactly like an absent literal: silent.
// Absence is not a finding — not every harness stores every file.
func expandCredentialPaths(home, rel string) []string {
	full := filepath.Join(home, rel)
	if !strings.ContainsAny(rel, "*?[") {
		if _, err := os.Lstat(full); err != nil {
			return nil
		}
		return []string{full}
	}
	matches, err := filepath.Glob(full)
	if err != nil {
		return nil
	}
	sort.Strings(matches) // deterministic output across runs
	return matches
}
```

Replace the body of `CheckCredentialFiles` with:

```go
func CheckCredentialFiles(home string, harnesses []string) []Finding {
	var out []Finding

	for _, h := range harnesses {
		paths, ok := CredentialPaths[h]
		if !ok {
			continue
		}
		for _, rel := range paths {
			for _, full := range expandCredentialPaths(home, rel) {
				out = append(out, checkOneCredentialFile(h, "", rel, full)...)
			}
		}
	}
	return out
}

// checkOneCredentialFile is shared by the host-level and per-station checks.
// station is "" for host-level files.
func checkOneCredentialFile(harness, station, label, full string) []Finding {
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // absence is not a finding
		}
		// We could not look. That is not the same as "it is fine", and a
		// scanner that silently downgrades one to the other earns distrust.
		return []Finding{{
			Check: CheckCredentialsID, Status: StatusUnknown, Severity: SeverityInfo,
			Harness: harness, Station: station,
			Title:  "Could not check a credential file",
			Detail: err.Error(), Path: full,
		}}
	}
	if info.IsDir() {
		return nil
	}

	exposure, err := EffectiveExposure(full)
	if err != nil {
		return []Finding{{
			Check: CheckCredentialsID, Status: StatusUnknown, Severity: SeverityInfo,
			Harness: harness, Station: station,
			Title:  "Could not determine who can reach a credential file",
			Detail: err.Error(), Path: full,
		}}
	}

	if exposure.Any() {
		who := "any user on this machine"
		sev := SeverityCritical
		if !exposure.World {
			who = "any user in this file's group"
		}
		return []Finding{{
			Check: CheckCredentialsID, Status: StatusFail, Severity: sev,
			Harness: harness, Station: station,
			Title: "Credentials readable by other users",
			Detail: fmt.Sprintf(
				"%s is mode %04o and reachable — %s can read it. It holds the keys this agent runs on.",
				label, info.Mode().Perm(), who),
			Path:   full,
			Remedy: fmt.Sprintf("chmod 600 %s", full),
		}}
	}

	return []Finding{{
		Check: CheckCredentialsID, Status: StatusPass, Severity: SeverityInfo,
		Harness: harness, Station: station,
		Title:  "Credential file is not readable by others",
		Detail: fmt.Sprintf("%s is mode %04o", label, info.Mode().Perm()),
		Path:   full,
	}}
}
```

Add `"sort"` and `"strings"` to the file's imports.

- [ ] **Step 5: Run the whole posture suite**

```bash
cd apps/node-agent && go test -race ./internal/posture/
```

Expected: PASS. Two pre-existing tests assert the old pass-title wording — update their expected strings to match `"Credential file is not readable by others"` rather than weakening the assertion.

- [ ] **Step 6: Commit — both fixes together**

```bash
git add apps/node-agent/internal/posture
git commit -m "fix(posture): correct credential paths and require real reachability

The shipped map named five files that exist on no machine we own, so
hermes and openclaw graded A having opened nothing. Correcting the paths
alone would report every 644 file under a 700 /root as critical, so
reachability lands in the same change."
```

---

## Task 3: Per-station credentials

**Files:**
- Create: `apps/node-agent/internal/posture/station.go`
- Create: `apps/node-agent/internal/posture/station_test.go`

**Interfaces:**
- Consumes: `checkOneCredentialFile`, `Finding`, `StatusFail`, `StatusPass` from Task 2.
- Produces: `func CheckStationCredentials(home string) []Finding`; `StationCredentialLayouts`.

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/posture/station_test.go`:

```go
package posture

import (
	"os"
	"path/filepath"
	"testing"
)

// hermesProfile builds ~/.hermes/profiles/<name>/ with the files molt-bot has.
func hermesProfile(t *testing.T, home, name string, mode os.FileMode) {
	t.Helper()
	dir := filepath.Join(home, ".hermes", "profiles", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"auth.json", ".env"} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("{}"), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(dir, f), mode); err != nil {
			t.Fatal(err)
		}
	}
}

// openclawAgent builds ~/.openclaw/agents/<name>/agent/ as on superchotu.
func openclawAgent(t *testing.T, home, name string, mode os.FileMode) {
	t.Helper()
	dir := filepath.Join(home, ".openclaw", "agents", name, "agent")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"auth.json", "auth-profiles.json", "auth-state.json"} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("{}"), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(dir, f), mode); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPerProfileHermesCredentialsAreChecked(t *testing.T) {
	// Confirmed on molt-bot: every profile has its own auth.json holding an
	// access token. The shipped scan never looked below ~/.hermes.
	home := t.TempDir()
	hermesProfile(t, home, "analyst-echo", 0o644)

	var fails int
	for _, f := range CheckStationCredentials(home) {
		if f.Status == StatusFail {
			fails++
		}
	}
	if fails == 0 {
		t.Fatal("a world-readable per-profile credential file must be reported")
	}
}

func TestPerProfileFindingsCarryTheStationKey(t *testing.T) {
	// The console joins a finding to a station by equality on this key, so the
	// format must match what hermes.go/openclaw.go produce.
	//
	// Hardcoded rather than imported from descriptor on purpose: this package's
	// doc comment keeps it free of the descriptor layer so the checks stay unit
	// testable. The cost is that the two can drift, which is why the expected
	// strings are spelled out here where a reader will see them.
	home := t.TempDir()
	hermesProfile(t, home, "analyst-echo", 0o644)
	openclawAgent(t, home, "hanuman", 0o644)

	want := map[string]bool{"hermes:analyst-echo": false, "openclaw:hanuman": false}
	for _, f := range CheckStationCredentials(home) {
		if _, ok := want[f.Station]; ok {
			want[f.Station] = true
		}
	}
	for k, seen := range want {
		if !seen {
			t.Errorf("no finding carried station key %q", k)
		}
	}
}

func TestPerAgentOpenclawCredentialsAreChecked(t *testing.T) {
	home := t.TempDir()
	openclawAgent(t, home, "hanuman", 0o644)

	var fails int
	for _, f := range CheckStationCredentials(home) {
		if f.Status == StatusFail {
			fails++
		}
	}
	if fails == 0 {
		t.Fatal("a world-readable per-agent credential file must be reported")
	}
}

func TestSecuredProfilesProduceNoFailures(t *testing.T) {
	home := t.TempDir()
	hermesProfile(t, home, "analyst-echo", 0o600)
	openclawAgent(t, home, "hanuman", 0o600)

	for _, f := range CheckStationCredentials(home) {
		if f.Status == StatusFail {
			t.Errorf("a 600 file must not be a failure: %+v", f)
		}
	}
}

func TestProfilesAreDiscoveredNotHardcoded(t *testing.T) {
	// molt-bot has 15 profiles with arbitrary names; superchotu has 12 agents.
	home := t.TempDir()
	for _, n := range []string{"analyst-echo", "coder-kai", "threat-hunter-theo"} {
		hermesProfile(t, home, n, 0o600)
	}
	seen := map[string]bool{}
	for _, f := range CheckStationCredentials(home) {
		if f.Station != "" {
			seen[f.Station] = true
		}
	}
	if len(seen) != 3 {
		t.Errorf("discovered %d profiles, want 3: %v", len(seen), seen)
	}
}

func TestNoProfilesIsSilent(t *testing.T) {
	if got := CheckStationCredentials(t.TempDir()); len(got) != 0 {
		t.Errorf("a home with no composite harnesses should produce nothing, got %+v", got)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/node-agent && go test ./internal/posture/ -run "TestPerProfile|TestPerAgent|TestSecuredProfiles|TestProfilesAre|TestNoProfiles"
```

Expected: FAIL — `undefined: CheckStationCredentials`.

- [ ] **Step 3: Implement it**

Create `apps/node-agent/internal/posture/station.go`:

```go
package posture

import (
	"os"
	"path/filepath"
	"sort"
)

// StationCredentialLayout describes where a composite harness keeps per-station
// secrets. Only composite harnesses have these; claude-code, codex and opencode
// keep everything at the host level.
type StationCredentialLayout struct {
	Harness string
	// ProfilesDir is relative to home and holds one directory per station.
	ProfilesDir string
	// Files are relative to a station's directory.
	Files []string
	// KeyPrefix builds the station key as KeyPrefix + ":" + <dir name>, matching
	// what the descriptors produce so the console can join on equality.
	KeyPrefix string
}

// StationCredentialLayouts is the observed layout of each composite harness.
//
// Verified 2026-08-11: molt-bot has 15 Hermes profiles each with auth.json and
// .env; superchotu has 12 OpenClaw agents each with agent/auth*.json. The
// descriptors read auth.json from these same directories for station identity,
// which is how we know they hold access tokens.
var StationCredentialLayouts = []StationCredentialLayout{
	{
		Harness:     "hermes",
		ProfilesDir: ".hermes/profiles",
		Files:       []string{"auth.json", ".env"},
		KeyPrefix:   "hermes", // hermes.go: key = "hermes:" + name
	},
	{
		Harness:     "openclaw",
		ProfilesDir: ".openclaw/agents",
		Files:       []string{"agent/auth.json", "agent/auth-profiles.json", "agent/auth-state.json"},
		KeyPrefix:   "openclaw", // openclaw.go: key = "openclaw:" + name
	},
}

// CheckStationCredentials inspects per-station credential files for every
// composite harness found under home.
//
// Station directories are discovered by listing, never hardcoded: the fleet has
// 15 Hermes profiles and 12 OpenClaw agents with arbitrary names.
func CheckStationCredentials(home string) []Finding {
	var out []Finding

	for _, layout := range StationCredentialLayouts {
		base := filepath.Join(home, layout.ProfilesDir)
		entries, err := os.ReadDir(base)
		if err != nil {
			continue // harness not installed here; absence is not a finding
		}

		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if e.IsDir() {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names) // deterministic across runs

		for _, name := range names {
			station := layout.KeyPrefix + ":" + name
			for _, rel := range layout.Files {
				full := filepath.Join(base, name, rel)
				label := filepath.Join(layout.ProfilesDir, name, rel)
				out = append(out, checkOneCredentialFile(layout.Harness, station, label, full)...)
			}
		}
	}
	return out
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/node-agent && go test -race ./internal/posture/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/posture
git commit -m "feat(posture): check per-station credentials on composite harnesses"
```

---

## Task 4: Directory modes and wiring into Scan

**Files:**
- Create: `apps/node-agent/internal/posture/dirs.go`
- Create: `apps/node-agent/internal/posture/dirs_test.go`
- Modify: `apps/node-agent/internal/posture/scan.go:16-29`

**Interfaces:**
- Consumes: `EffectiveExposure`, `StationCredentialLayouts`, `CheckStationCredentials`.
- Produces: `const CheckConfigDirID = "config.dir-writable"`; `func CheckConfigDirs(home string) []Finding`.

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/posture/dirs_test.go`:

```go
package posture

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGroupWritableStationDirIsAFinding(t *testing.T) {
	// superchotu 2026-08-11: ~/.openclaw/agents/<name>/ is 775. Anyone in the
	// group can REPLACE that agent's auth.json — which no file-mode check can
	// see, and which is worse than being able to read it.
	home := t.TempDir()
	dir := filepath.Join(home, ".openclaw", "agents", "hanuman")
	if err := os.MkdirAll(dir, 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o775); err != nil {
		t.Fatal(err)
	}

	var found bool
	for _, f := range CheckConfigDirs(home) {
		if f.Status == StatusFail && f.Station == "openclaw:hanuman" {
			found = true
		}
	}
	if !found {
		t.Error("a group-writable station config directory must be reported")
	}
}

func TestOwnerOnlyStationDirPasses(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".hermes", "profiles", "analyst-echo")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	for _, f := range CheckConfigDirs(home) {
		if f.Status == StatusFail {
			t.Errorf("a 700 directory must not be a failure: %+v", f)
		}
	}
}

func TestUnreachableWritableDirIsNotAFinding(t *testing.T) {
	// Same reachability rule as files: a 775 directory inside a 700 parent
	// cannot be written by anyone else.
	home := t.TempDir()
	agents := filepath.Join(home, ".openclaw", "agents")
	dir := filepath.Join(agents, "hanuman")
	if err := os.MkdirAll(dir, 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(agents, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(agents, 0o755) })

	for _, f := range CheckConfigDirs(home) {
		if f.Status == StatusFail {
			t.Errorf("an unreachable directory must not be a failure: %+v", f)
		}
	}
}

func TestScanIncludesStationAndDirectoryFindings(t *testing.T) {
	// Scan is what `apn scan` and the verb both call; a check that exists but is
	// not composed in is a check that does not run.
	home := t.TempDir()
	dir := filepath.Join(home, ".hermes", "profiles", "analyst-echo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	report := Scan(t.Context(), home, KnownHarnesses(), 1)

	var sawStation bool
	for _, f := range report.Findings {
		if f.Station == "hermes:analyst-echo" {
			sawStation = true
		}
	}
	if !sawStation {
		t.Error("Scan does not include per-station findings")
	}
	if report.Grade == "A" {
		t.Error("a world-readable per-profile credential must not grade A")
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/node-agent && go test ./internal/posture/ -run "TestGroupWritable|TestOwnerOnlyStationDir|TestUnreachableWritable|TestScanIncludes"
```

Expected: FAIL — `undefined: CheckConfigDirs`.

- [ ] **Step 3: Implement the directory check**

Create `apps/node-agent/internal/posture/dirs.go`:

```go
package posture

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// CheckConfigDirID covers a station config directory others can write to.
//
// Being able to REPLACE an agent's credentials is a different and worse problem
// than being able to read them, and no file-mode check can see it: the files
// inside can all be 600 while the directory holding them is group-writable.
const CheckConfigDirID = "config.dir-writable"

// CheckConfigDirs reports station config directories writable by others.
//
// Observed on superchotu 2026-08-11: ~/.openclaw/agents/<name>/ is mode 775.
func CheckConfigDirs(home string) []Finding {
	var out []Finding

	for _, layout := range StationCredentialLayouts {
		base := filepath.Join(home, layout.ProfilesDir)
		entries, err := os.ReadDir(base)
		if err != nil {
			continue
		}

		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if e.IsDir() {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)

		for _, name := range names {
			dir := filepath.Join(base, name)
			station := layout.KeyPrefix + ":" + name

			info, serr := os.Stat(dir)
			if serr != nil {
				continue
			}
			perm := info.Mode().Perm()
			writable := perm&0o022 != 0
			if !writable {
				out = append(out, Finding{
					Check: CheckConfigDirID, Status: StatusPass, Severity: SeverityInfo,
					Harness: layout.Harness, Station: station,
					Title:  "Station config directory is not writable by others",
					Detail: fmt.Sprintf("%s is mode %04o", dir, perm),
					Path:   dir,
				})
				continue
			}

			// Writable by mode is not writable in fact if nobody else can
			// traverse to it — the same rule the file checks use.
			exposure, eerr := EffectiveExposure(dir)
			if eerr != nil {
				out = append(out, Finding{
					Check: CheckConfigDirID, Status: StatusUnknown, Severity: SeverityInfo,
					Harness: layout.Harness, Station: station,
					Title: "Could not determine who can reach a station config directory",
					Detail: eerr.Error(), Path: dir,
				})
				continue
			}
			if !exposure.Any() {
				out = append(out, Finding{
					Check: CheckConfigDirID, Status: StatusPass, Severity: SeverityInfo,
					Harness: layout.Harness, Station: station,
					Title:  "Station config directory is not reachable by others",
					Detail: fmt.Sprintf("%s is mode %04o but an ancestor blocks traversal", dir, perm),
					Path:   dir,
				})
				continue
			}

			out = append(out, Finding{
				Check: CheckConfigDirID, Status: StatusFail, Severity: SeverityCritical,
				Harness: layout.Harness, Station: station,
				Title: "Station config directory is writable by other users",
				Detail: fmt.Sprintf(
					"%s is mode %04o — another user can replace this agent's credential files, "+
						"even though the files themselves are owner-only.", dir, perm),
				Path:   dir,
				Remedy: fmt.Sprintf("chmod 700 %s", dir),
			})
		}
	}
	return out
}
```

- [ ] **Step 4: Compose the new checks into Scan**

In `apps/node-agent/internal/posture/scan.go`, replace the body of `Scan` between `hostname` and `Sort`:

```go
	findings := CheckCredentialFiles(home, harnesses)
	findings = append(findings, CheckStationCredentials(home)...)
	findings = append(findings, CheckConfigDirs(home)...)
	findings = append(findings, CheckListeners(ctx)...)
	Sort(findings)
```

- [ ] **Step 5: Run the whole suite**

```bash
cd apps/node-agent && go test -race ./internal/posture/
```

Expected: PASS.

- [ ] **Step 6: Verify against this machine**

```bash
cd apps/node-agent && go run ./cmd/agentpod-node scan
```

Expected: it now names real files. On this Mac `~/.openclaw/openclaw.json`, `~/.claude.json`, `~/.codex/auth.json` and the opencode auth file are all 600, so a grade of A here is now *earned* rather than vacuous — confirm the check count rose from 5.

- [ ] **Step 7: Commit**

```bash
git add apps/node-agent/internal/posture
git commit -m "feat(posture): flag group-writable station config dirs; wire new checks into Scan"
```

---

## Task 5: Contract — posture report, node capabilities, verb

**Files:**
- Create: `packages/contract/src/posture.ts`
- Create: `packages/contract/src/posture.test.ts`
- Modify: `packages/contract/src/gateway.ts:5`
- Modify: `packages/contract/src/node.ts` (`NodeSummary`)
- Modify: `packages/contract/src/protocol.ts`
- Modify: `packages/contract/src/index.ts`
- Modify: `packages/contract/scripts/emit-go-fixtures.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PostureStatus`, `PostureSeverity`, `PostureFinding`, `PostureReport`, `NodeCapability`, `NodeCapabilityList`; `HelloMsg.capabilities`; `NodeSummary.capabilities`; `VERB_PARAMS["posture.scan"]`; `VERB_RESULTS["posture.scan"]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/contract/src/posture.test.ts`:

```ts
import { test, expect } from "bun:test";
import { PostureReport, PostureFinding, NodeCapabilityList } from "./posture";
import { HelloMsg } from "./gateway";
import { NodeSummary } from "./node";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";

const FINDING = {
  check: "creds.world-readable",
  status: "fail" as const,
  severity: "critical" as const,
  harness: "hermes",
  station: "hermes:analyst-echo",
  title: "Credentials readable by other users",
  detail: "mode 0644 and reachable",
  path: "/root/.hermes/profiles/analyst-echo/auth.json",
  remedy: "chmod 600 /root/.hermes/profiles/analyst-echo/auth.json",
};

test("a finding can name the station it belongs to", () => {
  // The console joins findings to stations by this key.
  expect(PostureFinding.parse(FINDING).station).toBe("hermes:analyst-echo");
});

test("host-level findings carry no station", () => {
  const { station, ...hostLevel } = FINDING;
  expect(PostureFinding.parse(hostLevel).station).toBeUndefined();
});

test("unknown is a first-class status, distinct from pass", () => {
  // A check that could not determine an answer must never be recorded as a pass.
  const f = PostureFinding.parse({ ...FINDING, status: "unknown", severity: "info" });
  expect(f.status).toBe("unknown");
});

test("a report carries the grade and the host it describes", () => {
  const r = PostureReport.parse({
    hostname: "molt-bot",
    stations: 15,
    findings: [FINDING],
    grade: "F",
  });
  expect(r.grade).toBe("F");
  expect(r.findings).toHaveLength(1);
});

test("hello may carry node capabilities, and may omit them", () => {
  // Omitted is how an older node degrades silently rather than erroring.
  const withCaps = HelloMsg.parse({
    type: "hello",
    hostInfo: { hostname: "h", os: "linux", arch: "amd64", cpuCount: 2 },
    version: "v0.1.22",
    capabilities: ["posture"],
  });
  expect(withCaps.capabilities).toEqual(["posture"]);

  const without = HelloMsg.parse({
    type: "hello",
    hostInfo: { hostname: "h", os: "linux", arch: "amd64", cpuCount: 2 },
  });
  expect(without.capabilities).toBeUndefined();
});

test("unknown node capabilities are filtered, not rejected", () => {
  // Same carry-in rule as station capabilities: an old hub must not break when
  // a newer node advertises something it has never heard of.
  expect(NodeCapabilityList.parse(["posture", "time-travel"])).toEqual(["posture"]);
});

test("NodeSummary exposes capabilities to the console", () => {
  const n = NodeSummary.parse({
    id: "node_1", name: "n", hostname: "h", os: "linux", arch: "amd64",
    cpuCount: 2, status: "online", lastSeenAt: null, createdAt: "now",
    agentVersion: "v0.1.22", latestVersion: null, updateAvailable: false,
    capabilities: ["posture"],
  });
  expect(n.capabilities).toEqual(["posture"]);
});

test("the posture verb is registered", () => {
  expect(VERB_PARAMS["posture.scan"].parse({})).toEqual({});
  expect(VERB_RESULTS["posture.scan"]).toBeDefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/contract && bun test src/posture.test.ts
```

Expected: FAIL — `Cannot find module './posture'`.

- [ ] **Step 3: Create the schemas**

Create `packages/contract/src/posture.ts`:

```ts
import { z } from "zod";

/**
 * Wire shapes for the `posture` capability — a live security read of a machine
 * running agent runtimes.
 *
 * Node-level, not station-level: credential files live in a user's home and a
 * listening socket belongs to a process, so one scan describes one machine.
 * Findings that DO belong to a station carry `station`, which is what lets the
 * console show a station its own problems without re-running anything.
 */

export const PostureStatus = z.enum(["pass", "fail", "unknown"]);
export type PostureStatus = z.infer<typeof PostureStatus>;

export const PostureSeverity = z.enum(["critical", "warning", "info"]);
export type PostureSeverity = z.infer<typeof PostureSeverity>;

/**
 * One observation about one thing.
 *
 * `check` is a stable id so reports can be diffed across runs, and `remedy` is
 * the exact command rather than general advice.
 *
 * `unknown` is deliberately not `pass`: a check that could not determine an
 * answer is reported honestly and excluded from grading, because grading on
 * ignorance is how a scanner earns distrust.
 */
export const PostureFinding = z.object({
  check: z.string().min(1),
  status: PostureStatus,
  severity: PostureSeverity,
  harness: z.string().min(1).optional(),
  /** Station key (e.g. `hermes:analyst-echo`) for per-station findings. */
  station: z.string().min(1).optional(),
  title: z.string().min(1),
  detail: z.string(),
  path: z.string().min(1).optional(),
  remedy: z.string().min(1).optional(),
});
export type PostureFinding = z.infer<typeof PostureFinding>;

export const PostureReport = z.object({
  hostname: z.string(),
  stations: z.number().int().nonnegative(),
  findings: z.array(PostureFinding),
  /** A — nothing · B — info only · C — a warning · F — a critical. */
  grade: z.string().min(1),
});
export type PostureReport = z.infer<typeof PostureReport>;

// ─── Node capabilities ───────────────────────────────────────────────────────

/**
 * Capabilities of a NODE, as opposed to a station.
 *
 * Carried in the `hello` frame rather than a separate verb, which means they
 * refresh on every connect by construction — the staleness bug that station
 * capabilities needed a fix for cannot occur here.
 */
export const NodeCapability = z.enum(["posture"]);
export type NodeCapability = z.infer<typeof NodeCapability>;

/**
 * Unknown entries are filtered rather than rejected, so an older hub keeps
 * working when a newer node advertises something it has never heard of.
 */
export const NodeCapabilityList = z
  .array(z.string())
  .transform((xs) => xs.filter((x): x is NodeCapability => NodeCapability.safeParse(x).success));
```

- [ ] **Step 4: Extend hello, NodeSummary and the verb tables**

In `packages/contract/src/gateway.ts`, add the import and extend `HelloMsg`:

```ts
import { NodeCapabilityList } from "./posture";
```

```ts
export const HelloMsg = z.object({
  type: z.literal("hello"),
  hostInfo: HostInfo,
  version: z.string().optional(),
  // Absent from older nodes — the hub treats that as "no node capabilities".
  capabilities: NodeCapabilityList.optional(),
});
```

In `packages/contract/src/node.ts`, add to `NodeSummary` after `updateAvailable`:

```ts
  capabilities: z.array(z.string()).nullable().optional(),
```

In `packages/contract/src/protocol.ts`, add the import:

```ts
import { PostureReport } from "./posture";
```

Add to `VERB_PARAMS` after the changeset entries:

```ts
  // Node-level: no station key. One scan describes one machine.
  "posture.scan": z.object({}),
```

Add to `VERB_RESULTS` after the changeset entries:

```ts
  "posture.scan": PostureReport,
```

In `packages/contract/src/index.ts`, add after the changeset export:

```ts
export * from "./posture";
```

- [ ] **Step 5: Run the contract suite**

```bash
cd packages/contract && bun test
```

Expected: PASS.

- [ ] **Step 6: Update the hello Go fixture**

In `packages/contract/scripts/emit-go-fixtures.ts`, change the `hello` fixture to include capabilities:

```ts
  ["hello", HelloMsg, {
    type: "hello",
    hostInfo: { hostname: "fleet-box-1", os: "linux", arch: "arm64", cpuCount: 8 },
    version: "v0.1.22",
    capabilities: ["posture"],
  }],
```

Then regenerate and check:

```bash
cd packages/contract && bun run scripts/emit-go-fixtures.ts && bun run scripts/emit-go-fixtures.ts --check
```

Expected: writes, then passes.

Note: `hello.json` is emitted but **no Go test currently round-trips it** — the node builds the hello frame as an inline `map[string]any` with no struct, the same gap `TestHealthFrameStationsRoundTrip` already flags in its comment ("an untyped map can drift from the contract without any test noticing"). Task 6 closes it.

- [ ] **Step 7: Commit**

```bash
git add packages/contract apps/node-agent/internal/contractfix/testdata
git commit -m "feat(contract): posture report, node capabilities in hello, posture.scan verb"
```

---

## Task 6: Node-agent — hello capabilities and the verb handler

**Files:**
- Create: `apps/node-agent/internal/gateway/posture.go`
- Create: `apps/node-agent/internal/gateway/posture_test.go`
- Modify: `apps/node-agent/internal/gateway/client.go:136-170`
- Modify: `apps/node-agent/cmd/agentpod-node/run.go`

**Interfaces:**
- Consumes: `posture.Scan`, `posture.KnownHarnesses` from Tasks 1-4; `Handler`, `HandlerFunc` from `dispatch.go`.
- Produces: `func NewPostureHandler(inner Handler, stationCount func() int) Handler`; `var NodeCapabilities = []string{"posture"}`; hello frame carries `capabilities`.

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/gateway/posture_test.go`:

```go
package gateway

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/posture"
)

func posturePassthrough() Handler {
	return HandlerFunc(func(_ context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		return "inner:" + verb, false, nil
	})
}

func TestPostureHandlerPassesOtherVerbsThrough(t *testing.T) {
	h := NewPostureHandler(posturePassthrough(), func() int { return 0 })
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got != "inner:health" {
		t.Errorf("got %v, want the inner handler's result", got)
	}
}

func TestPostureScanReturnsAGradedReport(t *testing.T) {
	h := NewPostureHandler(posturePassthrough(), func() int { return 7 })
	got, streamed, err := h.Handle(t.Context(), "posture.scan", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if streamed {
		t.Error("posture.scan returns a bounded result; it must not stream")
	}
	rep, ok := got.(posture.Report)
	if !ok {
		t.Fatalf("got %T, want posture.Report", got)
	}
	if rep.Grade == "" {
		t.Error("report has no grade")
	}
	if rep.Stations != 7 {
		t.Errorf("Stations = %d, want the injected count 7", rep.Stations)
	}
}

func TestPostureScanIgnoresParams(t *testing.T) {
	// The verb takes {} — a node-level scan has nothing to key on. Junk params
	// must not fail it, so an older or newer caller stays compatible.
	h := NewPostureHandler(posturePassthrough(), func() int { return 0 })
	if _, _, err := h.Handle(t.Context(), "posture.scan", json.RawMessage(`{"key":"ignored"}`), nil); err != nil {
		t.Fatalf("Handle: %v", err)
	}
}

func TestNodeCapabilitiesAdvertisesPosture(t *testing.T) {
	// This is what the hub gates the console tab on.
	var found bool
	for _, c := range NodeCapabilities {
		if c == "posture" {
			found = true
		}
	}
	if !found {
		t.Errorf("NodeCapabilities = %v, want it to include posture", NodeCapabilities)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/gateway/ -run TestPosture
```

Expected: FAIL — `undefined: NewPostureHandler`.

- [ ] **Step 3: Write the handler**

Create `apps/node-agent/internal/gateway/posture.go`:

```go
package gateway

import (
	"context"
	"encoding/json"
	"os"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/posture"
)

// NodeCapabilities is what this node advertises about ITSELF, as opposed to
// about a station. Sent in the hello frame on every connect, which is why node
// capabilities cannot go stale the way station capabilities could.
var NodeCapabilities = []string{"posture"}

// postureHandler wraps an inner Handler and adds the node-level posture verb.
type postureHandler struct {
	inner        Handler
	stationCount func() int
}

// NewPostureHandler wraps inner with posture.scan.
//
// stationCount is injected rather than detected here so the handler has no
// dependency on the descriptor layer — the same separation posture.Scan uses.
func NewPostureHandler(inner Handler, stationCount func() int) Handler {
	return &postureHandler{inner: inner, stationCount: stationCount}
}

func (h *postureHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	if verb != "posture.scan" {
		return h.inner.Handle(ctx, verb, params, emit)
	}

	// Params are deliberately ignored: a node-level scan has nothing to key on,
	// and rejecting unexpected fields would break compatibility for no gain.
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, false, err
	}

	n := 0
	if h.stationCount != nil {
		n = h.stationCount()
	}
	return posture.Scan(ctx, home, posture.KnownHarnesses(), n), false, nil
}
```

- [ ] **Step 4: Give the hello frame a type, and send capabilities**

The frame is currently an inline `map[string]any`, which is why no test can catch it drifting from the contract. Replace it with a struct so the round-trip test in Step 6 has something to check.

In `apps/node-agent/internal/gateway/client.go`, add near the top:

```go
// HelloMsg is the frame sent immediately on every connection.
//
// A struct rather than an inline map so contractfix can prove it still
// round-trips the contract's shape — the gap TestHealthFrameStationsRoundTrip
// warns about, where an untyped map drifts and no test notices.
type HelloMsg struct {
	Type         string        `json:"type"`
	HostInfo     host.HostInfo `json:"hostInfo"`
	Version      string        `json:"version,omitempty"`
	Capabilities []string      `json:"capabilities,omitempty"`
}
```

Then replace the marshal at line ~167:

```go
	hello, _ := json.Marshal(HelloMsg{
		Type:         "hello",
		HostInfo:     host.Info(),
		Version:      version,
		Capabilities: NodeCapabilities,
	})
```

Check `host.Info()`'s return type with `grep -n "func Info" internal/host/*.go` and use it exactly; if it is not `host.HostInfo`, use whatever it returns.

- [ ] **Step 5: Wire the handler**

In `apps/node-agent/cmd/agentpod-node/run.go`, add to the handler chain after the changeset handler:

```go
	h := gateway.NewTerminalHandler(descriptor.NewHandler(reg), resolver, mgr, lifecycleFn)
	h = gateway.NewChangesetHandler(h, resolver)
	h = gateway.NewPostureHandler(h, func() int { return len(reg.DetectAll()) })
	h = gateway.NewACPHandler(h, acpMgr, descriptor.NewCapabilityHandler(reg).ACPCommand)
	h = gateway.NewUpdateHandler(h, version)
```

- [ ] **Step 6: Cover the hello fixture with a round-trip test**

`hello.json` has been emitted since the fixture script was written and nothing has ever checked it. Now that Step 4 gives the frame a Go type, close the gap.

Append to `apps/node-agent/internal/contractfix/roundtrip_test.go`:

```go
// The hello frame carries node capabilities, which gate whole features in the
// console — a capability silently dropped here is a feature that never appears
// and produces no error anywhere. Until this test existed the frame was an
// inline map[string]any and nothing checked it at all.
func TestHelloRoundTrips(t *testing.T) {
	roundTrip(t, "hello.json", &gateway.HelloMsg{})
}
```

`gateway` is already imported by that file. Run it and watch it pass — then, to prove it actually detects drift, temporarily delete the `Capabilities` field from `HelloMsg`, confirm the test fails, and restore it.

- [ ] **Step 7: Run the full Go suite**

```bash
cd apps/node-agent && go vet ./... && go test -race ./...
```

Expected: PASS, including `contractfix`.

- [ ] **Step 8: Commit**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): posture.scan verb and node capabilities in hello"
```

---

## Task 7: Hub — persist node capabilities and route the verb

**Files:**
- Modify: `apps/hub/src/db/schema/nodes.ts:6-19`
- Modify: `apps/hub/src/services/node-registry.ts:102-110`
- Modify: `apps/hub/src/routes/gateway.ts:105-107`
- Create: `apps/hub/src/routes/node-posture.ts`
- Create: `apps/hub/src/routes/node-posture.test.ts`
- Modify: `apps/hub/src/index.ts`

**Interfaces:**
- Consumes: `NodeCapabilityList` from Task 5; `broker.request`.
- Produces: `nodes.capabilities` column; `setNodeCapabilities(nodeId, capabilities)`; `nodePostureRoutes` — `POST /api/nodes/:id/posture/scan`.

- [ ] **Step 1: Add the column and a migration**

In `apps/hub/src/db/schema/nodes.ts`, add to the `nodes` table after `agentVersion`:

```ts
  capabilities: jsonb("capabilities").$type<string[]>(),
```

Add `jsonb` to the `drizzle-orm/pg-core` import on line 1. Then generate the migration:

```bash
cd apps/hub && bun run db:generate
```

If that script does not exist, check `package.json` for the drizzle-kit script name and use it. Migrations auto-apply on hub boot, so no manual apply step is needed.

- [ ] **Step 2: Write the failing tests**

Create `apps/hub/src/routes/node-posture.test.ts`. Read `apps/hub/src/routes/station-cleanup.test.ts` first and reuse its `testApp`, `connectFakeNode`, and `pollUntil` shape — this file needs the same fake-node-over-WebSocket harness, answering `posture.scan` instead of `cleanup.plan`, and sending `capabilities: ["posture"]` in its hello frame.

```ts
const REPORT = {
  hostname: "molt-bot",
  stations: 15,
  findings: [
    {
      check: "creds.world-readable",
      status: "fail",
      severity: "critical",
      harness: "hermes",
      station: "hermes:analyst-echo",
      title: "Credentials readable by other users",
      detail: "mode 0644 and reachable",
      path: "/root/.hermes/profiles/analyst-echo/auth.json",
      remedy: "chmod 600 /root/.hermes/profiles/analyst-echo/auth.json",
    },
  ],
  grade: "F",
};

test("a node's capabilities are stored from its hello frame", async () => {
  // This is what gates the console tab. It rides the handshake, so it refreshes
  // on every connect and cannot go stale.
  const { nodeId } = await connectNodeWithCaps(["posture"]);
  await pollUntil(async () => {
    const row = await db.query.nodes.findFirst({ where: (n, { eq }) => eq(n.id, nodeId) });
    return row?.capabilities?.includes("posture") ? row : null;
  });
});

test("a node that sends no capabilities stores none", async () => {
  // An older node must degrade silently, not error.
  const { nodeId } = await connectNodeWithCaps(undefined);
  await new Promise((r) => setTimeout(r, 300));
  const row = await db.query.nodes.findFirst({ where: (n, { eq }) => eq(n.id, nodeId) });
  expect(row?.capabilities ?? null).toBeNull();
});

test("scan returns the node's report", async () => {
  const ctx = await withPostureNode(REPORT);
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("a node without the capability is 403 and is never called", async () => {
  const ctx = await withPostureNode(REPORT, []);
  try {
    const before = ctx.capturedMsgs.length;
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {});
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 200));
    expect(sawVerb(ctx.capturedMsgs.slice(before), "posture.scan")).toBe(false);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("unauthenticated is 401", async () => {
  const ctx = await withPostureNode(REPORT);
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {}, "anonymous");
    expect(res.status).toBe(401);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("another user's node is 404", async () => {
  const ctx = await withPostureNode(REPORT);
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/node_not_mine/posture/scan`, {});
    expect(res.status).toBe(404);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("an offline node is 409, not 502", async () => {
  const ctx = await withPostureNode(REPORT, ["posture"], "node offline");
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {});
    expect(res.status).toBe(409);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});

test("any other failure is 502", async () => {
  const ctx = await withPostureNode(REPORT, ["posture"], "lsof exploded");
  try {
    const res = await post(ctx.baseUrl, `/api/nodes/${ctx.nodeId}/posture/scan`, {});
    expect(res.status).toBe(502);
  } finally {
    ctx.fakeNode.close();
    ctx.server.stop(true);
  }
});
```

Write `connectNodeWithCaps`, `withPostureNode`, `post` and `sawVerb` as local helpers in this file, modelled on the changeset route test's `withCapableStation` / `post` / `sawVerb`.

- [ ] **Step 3: Run them and watch them fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/routes/node-posture.test.ts
```

Expected: FAIL — the module does not exist.

If the run errors on connection, start the test database:

```bash
docker run -d --name agentpod-test-postgres -e POSTGRES_USER=agentpod -e POSTGRES_PASSWORD=agentpod-dev-password -e POSTGRES_DB=agentpod -p 5434:5432 pgvector/pgvector:pg16
```

- [ ] **Step 4: Persist capabilities from hello**

In `apps/hub/src/services/node-registry.ts`, add beside `setNodeAgentVersion`:

```ts
/**
 * Store the node-level capabilities a node advertised in its hello frame.
 *
 * Called on every connect, so these cannot go stale — unlike station
 * capabilities, which needed an explicit refresh because they were only ever
 * written at adoption.
 */
export async function setNodeCapabilities(
  nodeId: string,
  capabilities: string[] | null
) {
  await db.update(nodes).set({ capabilities }).where(eq(nodes.id, nodeId));
}
```

In `apps/hub/src/routes/gateway.ts`, extend the hello branch:

```ts
        if (parsed.data.type === "hello") {
          const version = parsed.data.version ?? null;
          await setNodeAgentVersion(authed, version);
          // Absent means an older node: store null rather than an empty array,
          // so "did not say" stays distinguishable from "said nothing".
          await setNodeCapabilities(authed, parsed.data.capabilities ?? null);
        } else if (parsed.data.type === "heartbeat") {
```

Add `setNodeCapabilities` to the import from `../services/node-registry`.

- [ ] **Step 5: Write the route**

Create `apps/hub/src/routes/node-posture.ts`:

```ts
/**
 * Node Posture Route — POST /api/nodes/:id/posture/scan
 *
 * Node-level rather than station-level: credential files live in a user's home
 * and a listening socket belongs to a process, so one scan describes one
 * machine. Findings that belong to a station carry `station`, and the console
 * joins on that.
 *
 * Safety model (mirrors station-cleanup.ts, with node ownership in place of
 * station ownership):
 *   1. Authenticate (401 if anonymous).
 *   2. Node ownership → 404 if absent or not owned.
 *   3. Capability gate: node must advertise "posture" → 403 (no node call).
 *   4. broker.request().
 *   5. Respond. Node offline → 409; anything else → 502.
 *
 * Audited: a posture report names credential file paths, which is worth a
 * record. It is a deliberate click, not a poll, so it does not flood the log.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import * as broker from "../services/broker";
import { recordAudit } from "../services/audit";
import type { AuthUser } from "../auth/middleware";

function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

export const nodePostureRoutes = new Hono().post(
  "/nodes/:id/posture/scan",
  async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const nodeId = c.req.param("id");
    const rows = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.userId, user.id)));
    const node = rows[0];
    if (!node) {
      return c.json({ error: "Not Found" }, 404);
    }

    if (!Array.isArray(node.capabilities) || !node.capabilities.includes("posture")) {
      return c.json(
        { error: "Forbidden: node does not advertise posture capability" },
        403
      );
    }

    const audit = await recordAudit(db, {
      userId: user.id,
      nodeId: node.id,
      stationKey: "",
      verb: "posture.scan",
      params: {},
    });

    const result = await broker.request(node.id, "posture.scan", {});

    await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

    if (!result.ok) {
      return c.json(
        { error: result.error ?? "posture.scan failed" },
        brokerErrorStatus(result.error)
      );
    }
    return c.json(result.data);
  }
);
```

If `recordAudit` rejects an empty `stationKey`, read its signature and pass whatever it uses for node-scoped actions rather than inventing a sentinel.

- [ ] **Step 6: Mount it and expose capabilities on NodeSummary**

In `apps/hub/src/index.ts`, add the import beside the other node routes and mount it:

```ts
import { nodePostureRoutes } from './routes/node-posture.ts';
```

```ts
  .route('/api', nodePostureRoutes)                        // POST /api/nodes/:id/posture/scan
```

Then find where the hub builds `NodeSummary` rows for `GET /api/nodes` (`grep -rn "updateAvailable" apps/hub/src/`) and include `capabilities: row.capabilities ?? null`, so the console can gate on it.

- [ ] **Step 7: Run the hub suite**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/hub
git commit -m "feat(hub): store node capabilities from hello, route posture.scan"
```

---

## Task 8: Console — posture panel and station banner

**Files:**
- Modify: `apps/console/src/lib/api/client.ts`
- Create: `apps/console/src/lib/components/fleet/PosturePanel.svelte`
- Create: `apps/console/src/lib/components/fleet/PosturePanel.svelte.test.ts`
- Modify: `apps/console/src/routes/nodes/[id]/+page.svelte`
- Create: `apps/console/src/lib/components/stations/PostureBanner.svelte`
- Create: `apps/console/src/lib/components/stations/PostureBanner.svelte.test.ts`
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte`

**Interfaces:**
- Consumes: `POST /api/nodes/:id/posture/scan` from Task 7.
- Produces: `PostureFindingRow`, `PostureReportResult`, `nodePosture(nodeId)`; `PosturePanel` with props `{ nodeId }`; `PostureBanner` with props `{ nodeId, stationKey, harness }`.

- [ ] **Step 1: Add the API client functions**

Append to `apps/console/src/lib/api/client.ts`:

```ts
// ─── Posture endpoints ────────────────────────────────────────────────────────

export type PostureFindingRow = {
  check: string;
  status: "pass" | "fail" | "unknown";
  severity: "critical" | "warning" | "info";
  harness?: string;
  /** Station key (e.g. `hermes:analyst-echo`) for per-station findings. */
  station?: string;
  title: string;
  detail: string;
  path?: string;
  remedy?: string;
};

export type PostureReportResult = {
  hostname: string;
  stations: number;
  findings: PostureFindingRow[];
  grade: string;
};

export const nodePosture = (nodeId: string) =>
  http<PostureReportResult>(`/api/nodes/${nodeId}/posture/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
```

- [ ] **Step 2: Write the failing panel test**

Create `apps/console/src/lib/components/fleet/PosturePanel.svelte.test.ts`. Match `CleanupPanel.svelte.test.ts` conventions (static component import, `vi.restoreAllMocks()` in `beforeEach`, `afterEach(cleanup)`).

```ts
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import PosturePanel from "./PosturePanel.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const CLEAN: api.PostureReportResult = {
  hostname: "molt-bot",
  stations: 15,
  findings: [
    { check: "creds.world-readable", status: "pass", severity: "info", harness: "hermes", title: "Credential file is not readable by others", detail: "mode 0600" },
  ],
  grade: "A",
};

const BAD: api.PostureReportResult = {
  hostname: "molt-bot",
  stations: 15,
  findings: [
    { check: "creds.world-readable", status: "fail", severity: "critical", harness: "hermes", station: "hermes:analyst-echo", title: "Credentials readable by other users", detail: "mode 0644 and reachable", path: "/root/.hermes/profiles/analyst-echo/auth.json", remedy: "chmod 600 /root/.hermes/profiles/analyst-echo/auth.json" },
    { check: "listen.public", status: "unknown", severity: "info", title: "Could not check listeners", detail: "lsof not found" },
    { check: "creds.world-readable", status: "pass", severity: "info", harness: "codex", title: "Credential file is not readable by others", detail: "mode 0600" },
  ],
  grade: "F",
};

test("scanning shows the grade", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(CLEAN);
  const { getByRole, getByText } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));
  await waitFor(() => expect(getByText("A")).toBeTruthy());
});

test("failures are shown with their remedy", async () => {
  // The person reading this wants to know what to type, not to go looking.
  vi.spyOn(api, "nodePosture").mockResolvedValue(BAD);
  const { getByRole, getByText, container } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));

  await waitFor(() => expect(getByText(/Credentials readable by other users/)).toBeTruthy());
  expect(container.textContent).toMatch(/chmod 600/);
});

test("unknown findings are shown separately from passes", async () => {
  // A check that could not run is not a pass. Folding it into passes is how a
  // scanner quietly stops being trustworthy.
  vi.spyOn(api, "nodePosture").mockResolvedValue(BAD);
  const { getByRole, container } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));

  await waitFor(() => expect(container.textContent).toMatch(/could not|couldn't/i));
  expect(container.textContent).toMatch(/lsof not found/);
});

test("a failing finding names the station it belongs to", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(BAD);
  const { getByRole, container } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));
  await waitFor(() => expect(container.textContent).toMatch(/hermes:analyst-echo/));
});

test("a failed scan shows the error", async () => {
  vi.spyOn(api, "nodePosture").mockRejectedValue(new Error("node offline"));
  const { getByRole, container } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));
  await waitFor(() => expect(container.textContent).toMatch(/node offline/));
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/console && pnpm test -- PosturePanel
```

Expected: FAIL — the component does not exist.

- [ ] **Step 4: Write the panel**

Create `apps/console/src/lib/components/fleet/PosturePanel.svelte`. Model its structure on `CleanupPanel.svelte` — a scan button that populates state, `Card` for grouping, `Empty` for the nothing-found case.

```svelte
<script lang="ts">
  import { nodePosture } from "$lib/api/client";
  import type { PostureReportResult, PostureFindingRow } from "$lib/api/client";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";

  interface Props {
    nodeId: string;
  }

  let { nodeId }: Props = $props();

  let report = $state<PostureReportResult | null>(null);
  let scanning = $state(false);
  let scanError = $state<string | null>(null);

  const failures = $derived(report?.findings.filter((f) => f.status === "fail") ?? []);
  const unknowns = $derived(report?.findings.filter((f) => f.status === "unknown") ?? []);
  const passes = $derived(report?.findings.filter((f) => f.status === "pass") ?? []);

  /** Grade colour. A is the only unambiguously good outcome. */
  const gradeClass = $derived(
    report?.grade === "A"
      ? "text-emerald-600 dark:text-emerald-500"
      : report?.grade === "F"
        ? "text-destructive"
        : "text-amber-600 dark:text-amber-500"
  );

  async function scan() {
    scanning = true;
    scanError = null;
    try {
      report = await nodePosture(nodeId);
    } catch (e) {
      scanError = e instanceof Error ? e.message : "Couldn't scan this machine.";
    } finally {
      scanning = false;
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Posture</Card.Title>
    <Card.Description>
      Credential files and agent listeners on this machine. Nothing is stored —
      this reads the machine as it is now.
    </Card.Description>
  </Card.Header>

  <Card.Content class="flex flex-col gap-4">
    <div class="flex items-center gap-3">
      <Button variant="outline" size="sm" onclick={scan} disabled={scanning}>
        {scanning ? "Scanning…" : "Scan"}
      </Button>
      {#if report}
        <span class="text-2xl font-bold {gradeClass}">{report.grade}</span>
        <span class="text-muted-foreground text-xs">
          {report.findings.length} checked · {failures.length} failed · {unknowns.length} could not be determined
        </span>
      {/if}
    </div>

    {#if scanError}
      <p class="text-destructive text-sm">{scanError}</p>
    {/if}

    {#each failures as f (f.check + (f.path ?? "") + (f.station ?? ""))}
      <div class="border-destructive/40 rounded-md border-l-2 pl-3">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="destructive">{f.severity}</Badge>
          <span class="text-sm font-medium">{f.title}</span>
          {#if f.station}
            <code class="text-muted-foreground font-mono text-xs">{f.station}</code>
          {:else if f.harness}
            <span class="text-muted-foreground text-xs">{f.harness}</span>
          {/if}
        </div>
        <p class="text-muted-foreground mt-1 text-sm">{f.detail}</p>
        {#if f.remedy}
          <p class="mt-1 font-mono text-xs">fix: {f.remedy}</p>
        {/if}
      </div>
    {/each}

    {#each unknowns as f (f.check + (f.path ?? ""))}
      <div class="rounded-md border-l-2 border-amber-500/40 pl-3">
        <p class="text-sm font-medium">{f.title}</p>
        <p class="text-muted-foreground mt-1 text-sm">{f.detail}</p>
      </div>
    {/each}

    {#if report && failures.length === 0 && unknowns.length === 0}
      <p class="text-muted-foreground text-sm">
        Nothing exposed, nothing world-readable. {passes.length} check(s) passed.
      </p>
    {/if}
  </Card.Content>
</Card.Root>
```

- [ ] **Step 5: Render it on the node page, gated**

In `apps/console/src/routes/nodes/[id]/+page.svelte`, add the import:

```ts
  import PosturePanel from "$lib/components/fleet/PosturePanel.svelte";
```

Add the capability derivation beside the other node-derived values:

```ts
  const hasPosture = $derived(
    Array.isArray(node?.capabilities) && node!.capabilities.includes("posture")
  );
```

Then render it as its own section, immediately before the stations `<section>` at line ~138:

```svelte
  {#if hasPosture}
    <section class="space-y-3">
      <PosturePanel nodeId={id} />
    </section>
  {/if}
```

- [ ] **Step 6: Write the failing banner test**

Create `apps/console/src/lib/components/stations/PostureBanner.svelte.test.ts`:

```ts
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import PostureBanner from "./PostureBanner.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const REPORT: api.PostureReportResult = {
  hostname: "molt-bot",
  stations: 15,
  findings: [
    { check: "creds.world-readable", status: "fail", severity: "critical", harness: "hermes", station: "hermes:analyst-echo", title: "Credentials readable by other users", detail: "mode 0644" },
    { check: "creds.world-readable", status: "fail", severity: "critical", harness: "hermes", station: "hermes:coder-kai", title: "Credentials readable by other users", detail: "mode 0644" },
  ],
  grade: "F",
};

test("shows a warning when a finding names this station", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(REPORT);
  const { container } = render(PostureBanner, {
    props: { nodeId: "node_1", stationKey: "hermes:analyst-echo", harness: "hermes" },
  });
  await waitFor(() => expect(container.textContent).toMatch(/readable by other users/i));
});

test("stays silent for a station with no findings", async () => {
  // One fact must not be shown on all 39 stations. A banner that is always
  // there is a banner nobody reads.
  vi.spyOn(api, "nodePosture").mockResolvedValue(REPORT);
  const { container } = render(PostureBanner, {
    props: { nodeId: "node_1", stationKey: "hermes:writer-quill", harness: "hermes" },
  });
  await waitFor(() => expect(api.nodePosture).toHaveBeenCalled());
  expect(container.textContent?.trim()).toBe("");
});

test("stays silent when the scan fails", async () => {
  // This is a passive banner on someone else's page; a failed background scan
  // must not put an error where they did not ask for one.
  vi.spyOn(api, "nodePosture").mockRejectedValue(new Error("node offline"));
  const { container } = render(PostureBanner, {
    props: { nodeId: "node_1", stationKey: "hermes:analyst-echo", harness: "hermes" },
  });
  await waitFor(() => expect(api.nodePosture).toHaveBeenCalled());
  expect(container.textContent?.trim()).toBe("");
});
```

- [ ] **Step 7: Write the banner**

Create `apps/console/src/lib/components/stations/PostureBanner.svelte`:

```svelte
<script lang="ts">
  import { nodePosture } from "$lib/api/client";
  import type { PostureFindingRow } from "$lib/api/client";

  interface Props {
    nodeId: string;
    stationKey: string;
    harness: string;
  }

  let { nodeId, stationKey, harness }: Props = $props();

  let mine = $state<PostureFindingRow[]>([]);

  /** Only findings that name THIS station. Harness-level findings are shown on
   *  the node page: repeating one fact across every station sharing a harness
   *  turns a real problem into wallpaper. */
  async function load() {
    try {
      const report = await nodePosture(nodeId);
      mine = report.findings.filter((f) => f.status === "fail" && f.station === stationKey);
    } catch {
      // Passive banner on a page the user opened for something else — a failed
      // background scan must not put an error in front of them.
      mine = [];
    }
  }

  $effect(() => {
    void stationKey;
    void harness;
    load();
  });
</script>

{#if mine.length > 0}
  <div class="border-destructive/40 bg-destructive/5 rounded-md border p-3">
    {#each mine as f (f.check + (f.path ?? ""))}
      <p class="text-sm font-medium">{f.title}</p>
      <p class="text-muted-foreground mt-1 text-sm">{f.detail}</p>
      {#if f.remedy}
        <p class="mt-1 font-mono text-xs">fix: {f.remedy}</p>
      {/if}
    {/each}
    <a class="mt-2 inline-block text-xs underline" href="/nodes/{nodeId}">
      See this machine's full posture
    </a>
  </div>
{/if}
```

- [ ] **Step 8: Render the banner on the station page**

In `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte`, add the import and render it above the tab panels, gated on the station having a key and the node advertising posture. The station page already has `station` loaded; the node's capability list is not on that row, so fetch it via `listNodes(nodeId)` in `loadStation`, or render the banner unconditionally and let it stay silent — the banner already returns nothing when there are no matching findings and swallows errors, so unconditional rendering is acceptable and simpler.

```svelte
  {#if station}
    <PostureBanner {nodeId} stationKey={station.stationKey} harness={station.harness} />
  {/if}
```

- [ ] **Step 9: Run the console suite**

```bash
cd apps/console && pnpm check && pnpm test && pnpm build
```

Expected: PASS on all three.

- [ ] **Step 10: Commit**

```bash
git add apps/console
git commit -m "feat(console): node posture panel and per-station posture banner"
```

---

## Task 9: Full verification and PR

- [ ] **Step 1: Run every suite**

```bash
cd packages/contract && bun test
cd ../../apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd ../node-agent && go vet ./... && go test -race ./...
cd ../console && pnpm check && pnpm test && pnpm build
```

Expected: all four green — the four required checks on `main`.

- [ ] **Step 2: Verify the fixture check the way CI does**

```bash
cd packages/contract && bun run scripts/emit-go-fixtures.ts --check
```

- [ ] **Step 3: Verify the scan against a real fleet machine**

Build and run against a machine with a composite harness. superchotu has 12 OpenClaw agents; molt-bot has 15 Hermes profiles and is reachable at `46.225.24.70` (its Tailscale route reports offline — use SSH directly).

```bash
cd apps/node-agent && GOOS=linux GOARCH=amd64 go build -o /tmp/apn-posture ./cmd/agentpod-node
scp /tmp/apn-posture superchotu:/tmp/apn-posture
ssh superchotu '/tmp/apn-posture scan; echo "exit=$?"'
```

Expected: the check count is materially higher than the 5 the shipped version reports, per-agent paths appear in the output, and `agents/<name>/` at mode 775 is reported as a group-writable config directory. Compare against `ssh superchotu 'stat -c "%a %n" ~/.openclaw/agents/*'` to confirm the finding matches reality.

Then confirm the false-alarm guard on molt-bot, which has 15 profiles with `config.yaml` at 644 under a 700 `/root`:

```bash
scp /tmp/apn-posture buddhimaan-root:/tmp/apn-posture
ssh buddhimaan-root '/tmp/apn-posture scan; echo "exit=$?"'
```

Expected: **no** critical findings for those `config.yaml` files. If 15 criticals appear, the reachability walk is not being applied and Task 1 has regressed — stop and fix before opening the PR.

Remove the uploaded binaries afterwards:

```bash
ssh superchotu 'rm -f /tmp/apn-posture'
ssh buddhimaan-root 'rm -f /tmp/apn-posture'
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin posture-capability
gh pr create --title "feat: posture capability — and fix a scanner that graded machines A without reading them" --body "$(cat <<'EOF'
Implements `docs/superpowers/specs/2026-08-11-posture-capability-design.md` (Horizon 1).

Makes `apn scan`'s findings correct, then makes them visible from the console.

## The scanner was reporting false passes

`CredentialPaths` named files that exist on no machine we own. For hermes and
openclaw — the two composite harnesses — **not one path matched reality**, so
`apn scan` reported "grade A, nothing world-readable" having opened nothing.

Corrected against running machines: molt-bot (15 Hermes profiles), superchotu
(12 OpenClaw agents), and a macOS host. Every entry now carries the machine and
date it was verified on.

## File mode is not exposure

Correcting the paths alone would have made things worse. molt-bot has
`config.yaml` at 644 in every profile — under a 700 `/root`, so unreachable.
The old check inspected only the file's own bits and would have reported 15
false criticals, grading a correctly secured box F.

Findings now require **effective reachability**: the file grants read to a class
AND every ancestor grants traverse to it. The two fixes ship together because
either alone is wrong.

## Per-station credentials were never checked

Confirmed, not assumed: `MatrixIDFromProfile` reads `auth.json` from each
profile directory and its comment notes it ignores the other fields "including
access_token". Hermes profiles have `auth.json` and `.env`; OpenClaw agents have
`agent/auth{,-profiles,-state}.json`. `Finding.Station` was declared and never
assigned — it now carries the station key the descriptors produce, so the
console joins findings to stations by equality.

Also new: group-writable station config directories. `agents/<name>/` is 775 on
superchotu, so another user can **replace** an agent's credentials even though
the files themselves are 600 — invisible to any file-mode check.

## Surfacing

`posture.scan` is a node-level verb, gated on a new node-capability mechanism
carried in the existing `hello` frame. Because it rides the handshake, node
capabilities refresh on every connect — the staleness bug station capabilities
needed a fix for cannot occur here.

Console: a Posture panel on the node page, and on a station page a banner shown
only when a finding names that station.

Observe-only: no stored history, no fleet roll-up, no remediation. Those are
Horizon 3's continuous-posture item.

## Follow-ons filed

#237 (config-editor validation + refusing to open credential files, which
depends on the corrected path list) and #238 (node config editing).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01EohapceVTgobwUGTQ5LuyW
EOF
)"
```

- [ ] **Step 5: Wait for the four required checks**

```bash
gh pr checks --watch
```

Expected: `contract`, `hub`, `node-agent`, `console` all green.
