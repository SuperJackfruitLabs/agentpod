package posture

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// CheckCredentials is the check that maps to the strategy's headline number:
// 42,000 exposed instances, most of them holding provider keys in files that
// every user on the box can read.
//
// It looks only at *known* credential locations per harness. It deliberately
// does not scan file contents looking for secret-shaped strings — that is slow,
// wrong often enough to be annoying, and means reading people's keys in order
// to tell them their keys are readable.
const CheckCredentialsID = "creds.world-readable"

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

// KnownHarnesses returns every harness this package can check credentials for.
//
// The scan uses this rather than the detected station list on purpose: a
// credential file is a risk whether or not a station is currently in use.
// Checking only detected harnesses would hand a clean grade to a machine that
// has an unused harness installed with its keys world-readable — a false pass,
// which is the one outcome a scanner must never produce.
func KnownHarnesses() []string {
	out := make([]string, 0, len(CredentialPaths))
	for h := range CredentialPaths {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

// CheckCredentialFiles inspects the known credential paths for the given
// harnesses under home, and reports any that others can read.
//
// home is a parameter rather than os.UserHomeDir() so the check is testable
// without touching the real user's files.
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

// checkOneCredentialFile is shared by the host-level and per-station checks.
// station is "" for host-level files; label is what a human sees.
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

	exposure, err := exposureOf(full)
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
		if !exposure.World {
			who = "any user in this file's group"
		}
		return []Finding{{
			Check: CheckCredentialsID, Status: StatusFail, Severity: SeverityCritical,
			Harness: harness, Station: station,
			Title: "Credentials readable by other users",
			Detail: fmt.Sprintf(
				"%s is mode %04o and reachable — %s can read it. It holds the keys this agent runs on.",
				label, info.Mode().Perm(), who),
			Path:   full,
			Remedy: fmt.Sprintf("chmod 600 %s", full),
		}}
	}

	// A mode that grants read but an ancestor that blocks traversal is a pass —
	// and worth saying out loud, because "not readable by others" next to
	// "mode 0644" otherwise reads like a bug in the scanner.
	detail := fmt.Sprintf("%s is mode %04o", label, info.Mode().Perm())
	if info.Mode().Perm()&0o044 != 0 {
		detail += " but a parent directory blocks other users from reaching it"
	}

	return []Finding{{
		Check: CheckCredentialsID, Status: StatusPass, Severity: SeverityInfo,
		Harness: harness, Station: station,
		Title:  "Credential file is not readable by others",
		Detail: detail,
		Path:   full,
	}}
}
