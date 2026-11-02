package pi

import (
	"strings"
)

// envValue returns the value of name in env, and whether it was present.
func envValue(env []string, name string) (string, bool) {
	for _, e := range env {
		if strings.HasPrefix(e, name+"=") {
			return strings.TrimPrefix(e, name+"="), true
		}
	}
	return "", false
}
