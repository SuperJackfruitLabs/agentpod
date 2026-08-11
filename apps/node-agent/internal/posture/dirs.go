package posture

import (
	"fmt"
	"os"
	"path/filepath"
)

// CheckConfigDirID covers a station config directory others can write to.
//
// Being able to REPLACE an agent's credentials is a different and worse problem
// than being able to read them, and no file-mode check can see it: the files
// inside can all be 600 while the directory holding them is group-writable.
//
// Observed on superchotu 2026-08-11, where ~/.openclaw/agents/<name>/ is 775
// with every auth file inside it at 600.
const CheckConfigDirID = "config.dir-writable"

// CheckConfigDirs reports station config directories writable by others.
func CheckConfigDirs(home string) []Finding {
	var out []Finding

	for _, layout := range StationCredentialLayouts {
		base, names := stationDirs(home, layout)
		for _, name := range names {
			dir := filepath.Join(base, name)
			station := layout.KeyPrefix + ":" + name

			info, err := os.Stat(dir)
			if err != nil {
				continue
			}
			perm := info.Mode().Perm()

			if perm&0o022 == 0 {
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
			exposure, eerr := exposureOf(dir)
			if eerr != nil {
				out = append(out, Finding{
					Check: CheckConfigDirID, Status: StatusUnknown, Severity: SeverityInfo,
					Harness: layout.Harness, Station: station,
					Title:  "Could not determine who can reach a station config directory",
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
