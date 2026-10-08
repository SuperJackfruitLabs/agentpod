package gitidentity

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

// Author is who a station's commits are by: the agent, not the host.
//
// The hub decides it (from the station's agent and its forge account) and sends it with
// `git.identity.ensure`; the node records it beside the key and puts it in the harness's
// environment. The email is synthetic — an agent has no mailbox — and that is intended: it is what
// forge matches a commit to its account by.
type Author struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Identity is what the spawn path knows about a provisioned station.
type Identity struct {
	KeyPath string
	// Author is nil for an identity provisioned before authors were sent. Such a station still
	// pushes with its key; its commits carry whatever the host's git config says until the hub
	// next sends an ensure with an author.
	Author *Author
}

// authorFile sits beside the key, for the same reason the `.station` sidecar does: a file next to
// the key it describes cannot disagree with an index elsewhere.
func authorFile(root, stationID string) string {
	return KeyPath(root, stationID) + ".author"
}

// validate refuses what git would reject or silently rewrite. git strips `<`, `>` and newlines
// from an ident, so a name carrying one commits as something nobody chose.
func (a Author) validate() error {
	if strings.TrimSpace(a.Name) == "" || strings.TrimSpace(a.Email) == "" {
		return errors.New("gitidentity: an author needs both a name and an email")
	}
	if strings.ContainsAny(a.Name+a.Email, "<>\n\r\x00") {
		return errors.New("gitidentity: an author may not contain <, > or a line break")
	}
	return nil
}

// RecordAuthor stores who a station's commits are by. Refused for a station with no key: the spawn
// path finds an identity by its key, so an author without one would never be used.
func RecordAuthor(root, stationID string, a Author) error {
	if err := a.validate(); err != nil {
		return err
	}
	if _, err := os.Stat(KeyPath(root, stationID)); err != nil {
		return fmt.Errorf("gitidentity: no key for station %s: %w", stationID, err)
	}
	data, err := json.Marshal(a)
	if err != nil {
		return fmt.Errorf("gitidentity: encode author: %w", err)
	}
	if err := os.WriteFile(authorFile(root, stationID), data, 0o600); err != nil {
		return fmt.Errorf("gitidentity: record author: %w", err)
	}
	return nil
}

func readAuthor(keyPath string) *Author {
	data, err := os.ReadFile(keyPath + ".author")
	if err != nil {
		return nil
	}
	var a Author
	if json.Unmarshal(data, &a) != nil || a.validate() != nil {
		// A damaged sidecar is treated as absent: the key still pushes, and the next ensure
		// rewrites it. Better than refusing to start the harness over a commit name.
		return nil
	}
	return &a
}

// IdentityForStationKey finds a station's key and, if one was recorded, its author.
func IdentityForStationKey(root, stationKey string) (Identity, bool) {
	keyPath, ok := KeyPathForStationKey(root, stationKey)
	if !ok {
		return Identity{}, false
	}
	return Identity{KeyPath: keyPath, Author: readAuthor(keyPath)}, true
}

// Env is the environment a process acting for this station runs with: the push key, and the
// author and committer when one was recorded. Empty for a station with no identity — the common
// case, which must come through untouched.
//
// Environment and not git config, deliberately: it reaches every repository the agent touches,
// including ones cloned after provisioning, and writes nothing a later station could inherit.
// GIT_COMMITTER_* as well as GIT_AUTHOR_*, because a rebase, amend or cherry-pick records a
// committer, and a host's name there is the same misattribution in a different column.
func Env(root, stationKey string) []string {
	id, ok := IdentityForStationKey(root, stationKey)
	if !ok {
		return nil
	}
	env := []string{"GIT_SSH_COMMAND=" + SSHCommand(id.KeyPath)}
	if a := id.Author; a != nil {
		env = append(env,
			"GIT_AUTHOR_NAME="+a.Name,
			"GIT_AUTHOR_EMAIL="+a.Email,
			"GIT_COMMITTER_NAME="+a.Name,
			"GIT_COMMITTER_EMAIL="+a.Email,
		)
	}
	return env
}
