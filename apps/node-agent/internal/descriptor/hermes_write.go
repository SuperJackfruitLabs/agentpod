package descriptor

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// hermesEnvWriter writes a station's Matrix credential into a Hermes
// profile's .env file, as MATRIX_USER_ID and MATRIX_ACCESS_TOKEN.
//
// .env is the one file a Hermes harness actually loads its identity from on
// the deployed fleet: auth.json holds only credential_pool/providers, and
// config.yaml carries no matrix section (see the note atop matrix.go and
// issue #273). MatrixIDFromProfile still checks auth.json and config.yaml
// first — that is a discovery heuristic for the reader — but a writer that
// followed the same order would place the new mxid in auth.json, which the
// running harness never reads. The reader would then report the identity
// converged while the harness kept running under its old one. Writing
// anywhere but .env reproduces that outage.
type hermesEnvWriter struct{}

func (hermesEnvWriter) Harness() string { return "hermes" }

// Write updates MATRIX_USER_ID and MATRIX_ACCESS_TOKEN in profileDir/.env in
// place, leaving every other line byte-identical. It refuses in two distinct
// cases, both leaving the profile untouched:
//
//   - .env is absent: this is not a Hermes profile this writer recognises at
//     all.
//   - .env exists but is missing either credential key: fix round 1 on Task
//     5 ruled this out of the append path an earlier version took. Every
//     station this slice moves is already harness-mode and therefore already
//     carries both keys — that is precisely where the reader found its
//     current identity — so a profile missing one is not "values gone
//     stale", it is a shape with no station behind it yet (a freshly
//     provisioned home, or a harness never Matrix-enabled), and this writer
//     has no case that exercises filling it in. Bridge-to-harness conversion
//     can add that path deliberately, with its own test, when it exists.
//
// SECURITY: accessToken is written only into the .env file's own bytes. It
// never appears in a returned error, and the temp file used to make the
// write atomic is chmod'd 0600 before any data reaches it and is removed on
// every failure path, so it never outlives the write.
func (hermesEnvWriter) Write(profileDir, mxid, accessToken string) error {
	path := filepath.Join(profileDir, ".env")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("hermes: %s has no .env; refusing to write an unrecognised profile", profileDir)
		}
		return fmt.Errorf("hermes: reading .env: %w", err)
	}

	lines := strings.Split(string(data), "\n")
	sawUserID, sawToken := false, false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		withoutExport := strings.TrimPrefix(trimmed, "export ")
		exportPrefix := ""
		if withoutExport != trimmed {
			exportPrefix = "export "
		}
		key, _, found := strings.Cut(withoutExport, "=")
		if !found {
			continue
		}
		switch strings.TrimSpace(key) {
		case "MATRIX_USER_ID":
			lines[i] = exportPrefix + "MATRIX_USER_ID=" + mxid
			sawUserID = true
		case "MATRIX_ACCESS_TOKEN":
			lines[i] = exportPrefix + "MATRIX_ACCESS_TOKEN=" + accessToken
			sawToken = true
		}
	}

	// Distinct from the file-absent refusal above, so an operator can tell
	// "no .env at all" apart from "a .env this writer does not consider an
	// update target". See the doc comment for why this is a refusal and not
	// an append.
	if !sawUserID || !sawToken {
		return fmt.Errorf(
			"hermes: %s/.env is missing %s; refusing to write a credential into a profile that has never held one",
			profileDir, missingCredentialKeys(sawUserID, sawToken),
		)
	}

	return atomicWriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
}

// missingCredentialKeys names which of the two credential keys Write did not
// find, for the refusal error above.
func missingCredentialKeys(sawUserID, sawToken bool) string {
	switch {
	case !sawUserID && !sawToken:
		return "MATRIX_USER_ID and MATRIX_ACCESS_TOKEN"
	case !sawUserID:
		return "MATRIX_USER_ID"
	default:
		return "MATRIX_ACCESS_TOKEN"
	}
}
