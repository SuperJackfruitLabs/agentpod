package descriptor

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// MatrixCredentials is what a harness-mode profile logs in to Matrix with.
//
// SECURITY: AccessToken must never be logged, folded into an error string, or
// returned in a verb result. It exists to authenticate requests this node makes
// to the homeserver on the harness's behalf, and nowhere else.
type MatrixCredentials struct {
	Homeserver  string
	UserID      string
	AccessToken string
}

// ErrNoMatrixCredentials is returned when a profile's .env lacks any of the
// three keys. It names the keys, never a value.
var ErrNoMatrixCredentials = errors.New(
	"the profile's .env has no complete Matrix login (MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN)",
)

// MatrixCredentialsFromEnv reads a Hermes profile's Matrix login from its .env.
//
// .env is where the deployed fleet keeps it (see the notes atop matrix.go and
// hermes_write.go); auth.json and config.yaml carry no token. Only the three
// named keys are read — every other line, MATRIX_RECOVERY_KEY included, is
// skipped before its value is split out.
func MatrixCredentialsFromEnv(profileDir string) (MatrixCredentials, error) {
	data, err := os.ReadFile(filepath.Join(profileDir, ".env"))
	if err != nil {
		if os.IsNotExist(err) {
			return MatrixCredentials{}, ErrNoMatrixCredentials
		}
		// Not wrapped with the path's contents — there are none in err — but
		// kept terse so nothing about the file beyond "unreadable" leaks.
		return MatrixCredentials{}, errors.New("the profile's .env is unreadable")
	}

	var c MatrixCredentials
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		trimmed = strings.TrimPrefix(trimmed, "export ")
		key, value, found := strings.Cut(trimmed, "=")
		if !found {
			continue
		}
		var dst *string
		switch strings.TrimSpace(key) {
		case "MATRIX_HOMESERVER":
			dst = &c.Homeserver
		case "MATRIX_USER_ID":
			dst = &c.UserID
		case "MATRIX_ACCESS_TOKEN":
			dst = &c.AccessToken
		default:
			continue
		}
		*dst = strings.Trim(strings.TrimSpace(value), `"'`)
	}

	if c.Homeserver == "" || c.AccessToken == "" || validateMXID(c.UserID) == nil {
		return MatrixCredentials{}, ErrNoMatrixCredentials
	}
	c.Homeserver = strings.TrimSuffix(c.Homeserver, "/")
	return c, nil
}
