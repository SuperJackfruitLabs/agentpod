package descriptor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// mxidRe matches a valid Matrix user ID: @localpart:domain
var mxidRe = regexp.MustCompile(`^@[^:]+:.+$`)

// MatrixIDFromProfile reads the Matrix user ID (mxid) for an agent profile.
// It tries auth.json first (reading ONLY the user_id field), then config.yaml,
// then .env (reading ONLY MATRIX_USER_ID). It validates the value matches the
// mxid shape ^@[^:]+:.+$ and returns nil if not found, invalid, or on any error.
//
// The .env source matters on the deployed fleet: there the Matrix identity of a
// Hermes home/profile lives in its .env as MATRIX_USER_ID, while auth.json holds
// only credential_pool/providers and config.yaml has no matrix section. Without
// it this function returns nil on real hosts (see issue #273).
//
// SECURITY: access_token / MATRIX_ACCESS_TOKEN and all other fields are never
// read, logged, or returned.
// Missing file / bad JSON / missing field → nil, never panic.
func MatrixIDFromProfile(profileDir, _ string) *string {
	// Try auth.json first.
	if mxid := mxidFromAuthJSON(profileDir); mxid != nil {
		return mxid
	}
	// Then config.yaml.
	if mxid := mxidFromConfigYAML(profileDir); mxid != nil {
		return mxid
	}
	// Finally .env.
	return mxidFromEnvFile(profileDir)
}

// mxidFromAuthJSON reads ONLY the user_id field from auth.json.
// All other fields (including access_token) are ignored by the JSON decoder
// because we unmarshal into a struct with a single exported field.
func mxidFromAuthJSON(profileDir string) *string {
	path := filepath.Join(profileDir, "auth.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil // file absent or unreadable — not an error
	}

	// Unmarshal into a minimal struct so that access_token and every other
	// key is silently discarded by encoding/json. This is the security boundary.
	var creds struct {
		UserID string `json:"user_id"`
		// NOTE: access_token intentionally omitted — never decoded.
	}
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil
	}

	// Also try "mxid" key as an alias.
	if creds.UserID == "" {
		var alt struct {
			MXID string `json:"mxid"`
		}
		if err := json.Unmarshal(data, &alt); err == nil && alt.MXID != "" {
			creds.UserID = alt.MXID
		}
	}

	return validateMXID(creds.UserID)
}

// mxidFromConfigYAML extracts a user_id or matrix.user_id or mxid key from
// config.yaml. We parse it with a minimal line-by-line approach so we never
// need a YAML library dependency, and to ensure we only read the intended field.
func mxidFromConfigYAML(profileDir string) *string {
	path := filepath.Join(profileDir, "config.yaml")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	// A station's own Matrix id lives at the top level of the file, or as an
	// IMMEDIATE child of `matrix:`. Depth is the whole point of this function.
	//
	// The first version matched `user_id:` at any indentation and tracked a
	// `matrix:` section it then never consulted. That is not a style problem. A
	// Hermes profile with a home channel looks like this:
	//
	//	platforms:
	//	  matrix:
	//	    home_channel:
	//	      user_id: '@rakesh:id.agentpod.dev'
	//
	// and that `user_id` is correct config — it names the human counterpart of
	// the DM. Read as the station's own identity it made the operator's mxid
	// ambiguous, so `resolveMatrixId` could attribute nothing they sent; it made
	// the agent's messages attributable to them; and it made fleet liveness
	// check the operator's phone to decide whether an agent was alive. The fleet
	// reported 14/14 throughout.
	//
	// Line scanning still, rather than a YAML dependency — but indentation is
	// now read instead of ignored.
	lines := strings.Split(string(data), "\n")
	matrixIndent := -1 // indent of the `matrix:` key, or -1 when outside it
	childIndent := -1  // indent of its immediate children, learned from the first
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " \t"))

		// Leaving the matrix section: a key at or above its own indentation.
		if matrixIndent >= 0 && indent <= matrixIndent {
			matrixIndent, childIndent = -1, -1
		}

		if trimmed == "matrix:" {
			matrixIndent, childIndent = indent, -1
			continue
		}

		if matrixIndent >= 0 && childIndent == -1 {
			childIndent = indent
		}

		var value string
		switch {
		case strings.HasPrefix(trimmed, "user_id:"):
			value = strings.TrimSpace(strings.TrimPrefix(trimmed, "user_id:"))
		case strings.HasPrefix(trimmed, "mxid:"):
			value = strings.TrimSpace(strings.TrimPrefix(trimmed, "mxid:"))
		default:
			continue
		}

		// Top level, or an immediate child of `matrix:`. Anything deeper belongs
		// to some other object and is not this station's identity.
		atTopLevel := matrixIndent < 0 && indent == 0
		isMatrixChild := matrixIndent >= 0 && indent == childIndent
		if !atTopLevel && !isMatrixChild {
			continue
		}

		value = strings.Trim(value, `"\'`)

		if m := validateMXID(value); m != nil {
			return m
		}
	}
	return nil
}

// mxidFromEnvFile extracts MATRIX_USER_ID from a dotenv-style .env file.
//
// Only the MATRIX_USER_ID key is ever considered: every other line — including
// MATRIX_ACCESS_TOKEN — is skipped before its value is even split out, which is
// the security boundary for this source.
func mxidFromEnvFile(profileDir string) *string {
	data, err := os.ReadFile(filepath.Join(profileDir, ".env"))
	if err != nil {
		return nil
	}

	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		// Allow the `export KEY=VALUE` form used by shell-sourced env files.
		trimmed = strings.TrimPrefix(trimmed, "export ")
		key, value, found := strings.Cut(trimmed, "=")
		if !found || strings.TrimSpace(key) != "MATRIX_USER_ID" {
			continue // never look at any other key's value
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if m := validateMXID(value); m != nil {
			return m
		}
	}
	return nil
}

// validateMXID returns a pointer to the trimmed mxid if it matches the
// expected shape ^@[^:]+:.+$, otherwise nil.
func validateMXID(raw string) *string {
	v := strings.TrimSpace(raw)
	if v == "" || !mxidRe.MatchString(v) {
		return nil
	}
	result := v
	return &result
}
