package posture

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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
// user's home directory. Adding a harness means adding a line here.
//
// Verified against a real fleet on 2026-08-11: these are the paths the
// descriptors already read for detection, minus anything that is not secret.
var CredentialPaths = map[string][]string{
	"openclaw":    {".openclaw/config.json", ".openclaw/credentials.json", ".openclaw/gateway.json"},
	"hermes":      {".hermes/config.json", ".hermes/credentials.json"},
	"claude-code": {".claude/.credentials.json", ".claude.json"},
	"codex":       {".codex/auth.json", ".codex/config.toml"},
	"opencode":    {".local/share/opencode/auth.json"},
}

// worldOrGroupReadable reports whether mode grants read to group or other.
func worldOrGroupReadable(mode fs.FileMode) bool {
	return mode.Perm()&0o044 != 0
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
			full := filepath.Join(home, rel)
			info, err := os.Stat(full)
			if err != nil {
				// Absent is not a finding: not every harness stores every file.
				// A permission error on the stat itself is worth saying, though,
				// because it means we cannot answer — not that the answer is good.
				if !os.IsNotExist(err) {
					out = append(out, Finding{
						Check: CheckCredentialsID, Status: StatusUnknown, Severity: SeverityInfo,
						Harness: h, Title: "Could not check a credential file",
						Detail: err.Error(), Path: full,
					})
				}
				continue
			}
			if info.IsDir() {
				continue
			}

			if worldOrGroupReadable(info.Mode()) {
				out = append(out, Finding{
					Check: CheckCredentialsID, Status: StatusFail, Severity: SeverityCritical,
					Harness: h,
					Title:   "Credentials readable by other users",
					Detail: fmt.Sprintf(
						"%s is mode %04o — any user on this machine can read it. It holds the keys this agent runs on.",
						rel, info.Mode().Perm()),
					Path:   full,
					Remedy: fmt.Sprintf("chmod 600 %s", full),
				})
				continue
			}

			out = append(out, Finding{
				Check: CheckCredentialsID, Status: StatusPass, Severity: SeverityInfo,
				Harness: h, Title: "Credential file is owner-only",
				Detail: fmt.Sprintf("%s is mode %04o", rel, info.Mode().Perm()),
				Path:   full,
			})
		}
	}
	return out
}
