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
// place, leaving every other line byte-identical. It refuses when .env is
// absent: that is not a Hermes profile this writer recognises, and refusing
// is the default rather than creating one from nothing.
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
	// Both keys are expected on the deployed fleet, but a profile missing one
	// (e.g. a freshly provisioned home with no prior Matrix credential) gets
	// it appended rather than silently dropped.
	if !sawUserID {
		lines = append(lines, "MATRIX_USER_ID="+mxid)
	}
	if !sawToken {
		lines = append(lines, "MATRIX_ACCESS_TOKEN="+accessToken)
	}

	return atomicWriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
}
