package descriptor

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
)

// WorkspaceRooter is an OPTIONAL interface: the root a descriptor's ReadFile passes to safeJoin.
// Linking an artifact (offset reads, fs.walk) needs it; a descriptor without it refuses those.
type WorkspaceRooter interface {
	WorkspaceRoot(key string) (string, error)
}

// MaxChunk caps one offset read.
const MaxChunk = 4 << 20

// deniedRules is the spec §8 default denylist. It mirrors Superlibrary's DENIED_RULES
// (packages/contract/src/paths.ts) and may only be stricter. Matching ignores case and strips
// trailing dots and spaces from each segment. Keep the two lists in step.
var deniedRules = []struct {
	rule string
	test func(segs []string) bool
}{
	{".env*", anySeg(func(s string) bool { return strings.HasPrefix(s, ".env") })},
	{".ssh/", dirSeg(".ssh")},
	{".gnupg/", dirSeg(".gnupg")},
	{"*.pem", base(func(b string) bool { return strings.HasSuffix(b, ".pem") })},
	{"*.key", base(func(b string) bool { return strings.HasSuffix(b, ".key") })},
	{"id_*", base(func(b string) bool { return strings.HasPrefix(b, "id_") })},
	{".git/", dirSeg(".git")},
	{".netrc", base(func(b string) bool { return b == ".netrc" })},
	{".npmrc", base(func(b string) bool { return b == ".npmrc" })},
	{".pypirc", base(func(b string) bool { return b == ".pypirc" })},
	{".git-credentials", base(func(b string) bool { return b == ".git-credentials" })},
	{"cloud credentials", func(s []string) bool {
		return dirSeg(".aws")(s) || dirSeg(".azure")(s) || dirSeg(".kube")(s) || sub(".config", "gcloud")(s) ||
			sub(".docker", "config.json")(s) ||
			base(func(b string) bool { return b == "application_default_credentials.json" || b == "credentials.json" })(s)
	}},
	{"harness files", func(s []string) bool {
		for _, d := range []string{".claude", ".codex", ".gemini", ".cursor", ".hermes", ".openclaw", ".opencode", ".pi"} {
			if dirSeg(d)(s) {
				return true
			}
		}
		return base(func(b string) bool { return b == ".claude.json" || b == "auth.json" || b == ".credentials.json" })(s) ||
			sub(".config", "opencode")(s) || sub(".local", "share", "opencode")(s) || sub(".config", "goose")(s)
	}},
}

func anySeg(pred func(string) bool) func([]string) bool {
	return func(s []string) bool {
		for _, x := range s {
			if pred(x) {
				return true
			}
		}
		return false
	}
}

func dirSeg(name string) func([]string) bool {
	return func(s []string) bool {
		for _, x := range s[:len(s)-1] {
			if x == name {
				return true
			}
		}
		return false
	}
}

func base(pred func(string) bool) func([]string) bool {
	return func(s []string) bool { return pred(s[len(s)-1]) }
}

// sub matches the segments parts as a consecutive run anywhere in the path.
func sub(parts ...string) func([]string) bool {
	return func(s []string) bool {
		for i := 0; i+len(parts) <= len(s); i++ {
			ok := true
			for j, p := range parts {
				if s[i+j] != p {
					ok = false
					break
				}
			}
			if ok {
				return true
			}
		}
		return false
	}
}

// Denied reports the rule a relative path breaks, if any.
func Denied(rel string) (string, bool) {
	var segs []string
	for _, s := range strings.Split(strings.ReplaceAll(rel, "\\", "/"), "/") {
		if s == "" || s == "." {
			continue
		}
		segs = append(segs, strings.ToLower(strings.TrimRight(s, ". ")))
	}
	if len(segs) == 0 {
		return "", false
	}
	for _, r := range deniedRules {
		if r.test(segs) {
			return r.rule, true
		}
	}
	return "", false
}

// ErrDenied marks a path the denylist refuses.
var ErrDenied = errors.New("path denied")

// ReadAt reads up to max bytes of rel from offset, inside root (symlinks resolved, spec §8).
// It returns the bytes, the file's size, and whether the read reached the end.
func ReadAt(root, rel string, offset, max int64) ([]byte, int64, bool, error) {
	if rule, ok := Denied(rel); ok {
		return nil, 0, false, fmt.Errorf("%w: %s (%s)", ErrDenied, rel, rule)
	}
	if offset < 0 {
		return nil, 0, false, fmt.Errorf("offset must not be negative")
	}
	if max <= 0 || max > MaxChunk {
		max = MaxChunk
	}
	target, err := fsops.Jail(root, rel)
	if err != nil {
		return nil, 0, false, err
	}
	f, err := os.Open(target)
	if err != nil {
		return nil, 0, false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, 0, false, err
	}
	if !info.Mode().IsRegular() {
		return nil, 0, false, fmt.Errorf("%s is not a regular file", rel)
	}
	buf := make([]byte, max)
	n, err := f.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, 0, false, err
	}
	return buf[:n], info.Size(), offset+int64(n) >= info.Size(), nil
}
