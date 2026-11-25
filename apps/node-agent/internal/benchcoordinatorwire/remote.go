package benchcoordinatorwire

import (
	"regexp"
	"unicode/utf8"
)

// The remote launch's two operations. attach asks the bench host's node for a
// writer certificate for the remote agent's public key (again, with the same
// key, to renew it); finish hands it the agent's report, and the node
// checkpoints, stops and releases. Neither carries a lease token, a private
// key or a path the hub chose.

// MaxPublicKey bounds attach's public key line, in bytes.
const MaxPublicKey = 8192

// MaxHandoff bounds finish's handoff, in canonical bytes (see canonicalSize).
const MaxHandoff = 32 << 10

var (
	certificatePattern = regexp.MustCompile(`^(ssh-ed25519|ecdsa-sha2-nistp256)-cert-v01@openssh\.com [A-Za-z0-9+/=]+( [ -~]*)?$`)
	userPattern        = regexp.MustCompile(`^b-[a-f0-9]{32}$`)
	addressPattern     = regexp.MustCompile(`^([0-9]{1,3}(\.[0-9]{1,3}){3}|\[[0-9A-Fa-f:.]+\]):[0-9]{1,5}$`)
	hostKeyPattern     = regexp.MustCompile(`^[a-z0-9@.-]{1,64} [A-Za-z0-9+/=]+( [ -~]*)?$`)
	fingerprintPattern = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{1,128}$`)
	timePattern        = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
)

// printable is valid UTF-8 with no control character.
func printable(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r >= 0x80 && r < 0xa0 {
			return false
		}
	}
	return true
}

func validPublicKey(key string) bool {
	return key != "" && len(key) <= MaxPublicKey && printable(key)
}

func validReport(r *Report) bool {
	return r != nil && r.Outcome == "complete" && r.Handoff != nil && canonicalSize(r.Handoff) <= MaxHandoff
}

func validCredential(c RemoteCredential) bool {
	return len(c.Certificate) <= 16384 && certificatePattern.MatchString(c.Certificate) && userPattern.MatchString(c.User) && addressPattern.MatchString(c.Address) &&
		len(c.HostKey) <= MaxPublicKey && hostKeyPattern.MatchString(c.HostKey) && fingerprintPattern.MatchString(c.HostKeyFingerprint) && idPattern.MatchString(c.LeaseID) &&
		c.Generation >= 1 && c.Generation <= 9007199254740991 && timePattern.MatchString(c.ValidBefore) &&
		len(c.WorkingDirectory) <= 4096 && len(c.WorkingDirectory) > 1 && c.WorkingDirectory[0] == '/' && printable(c.WorkingDirectory)
}

// canonicalSize is the length of the handoff's canonical encoding (the
// owner's codec: sorted keys, printable ASCII literal, everything else a
// \uXXXX escape, a supplementary character a surrogate pair of them).
func canonicalSize(handoff map[string]string) int {
	text := func(s string) int {
		n := 2
		for _, r := range s {
			switch {
			case r == '"' || r == '\\':
				n += 2
			case r >= 32 && r <= 126:
				n++
			case r > 0xffff:
				n += 12
			default:
				n += 6
			}
		}
		return n
	}
	n := 2
	for k, v := range handoff {
		n += text(k) + 1 + text(v) + 1
	}
	if len(handoff) > 0 {
		n--
	}
	return n
}
