package benchworkspace

import (
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var scpUsername = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
var scpHostname = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]*$`)

// These transport/ref predicates match the published checkpoint identity rules.
// They validate syntax only; execution must apply its exact authorized repository vector.
func validRepository(repository string) bool {
	if len(repository) < 1 || len(repository) > 4096 || !utf8.ValidString(repository) || repository[0] == '-' || strings.ContainsAny(repository, "\x00\r\n") {
		return false
	}
	// Absolute filesystem paths retain literal punctuation and spaces as identity.
	if strings.HasPrefix(repository, "/") {
		return true
	}
	if strings.Contains(repository, "://") {
		parsed, err := url.Parse(repository)
		if err != nil || parsed.Opaque != "" || strings.ContainsAny(repository, "?#") {
			return false
		}
		if strings.HasPrefix(parsed.Host, "[") &&
			(!strings.Contains(parsed.Hostname(), ":") || net.ParseIP(parsed.Hostname()) == nil) {
			return false
		}
		if port := parsed.Port(); port != "" {
			if _, err := strconv.ParseUint(port, 10, 16); err != nil {
				return false
			}
		}
		switch strings.ToLower(parsed.Scheme) {
		case "http", "https":
			return parsed.User == nil && parsed.Hostname() != ""
		case "ssh":
			if parsed.Hostname() == "" {
				return false
			}
			if parsed.User != nil {
				if _, password := parsed.User.Password(); password || parsed.User.Username() == "" {
					return false
				}
			}
			return true
		case "file":
			localhost := strings.EqualFold(parsed.Host, "localhost")
			return parsed.User == nil && (parsed.Host == "" || localhost) &&
				(strings.HasPrefix(parsed.Path, "/") || parsed.Path == "")
		default:
			return false
		}
	}
	// SCP syntax permits username identity but no password. A slash before the
	// colon would instead be a relative local path, which is not a stable identity.
	user, address, ok := strings.Cut(repository, "@")
	if !ok || !scpUsername.MatchString(user) {
		return false
	}
	if strings.HasPrefix(address, "[") {
		end := strings.Index(address, "]:")
		if end < 0 || len(address[end+2:]) == 0 {
			return false
		}
		host := address[1:end]
		return strings.Contains(host, ":") && net.ParseIP(host) != nil
	}
	host, path, ok := strings.Cut(address, ":")
	if !ok || !scpHostname.MatchString(host) || path == "" {
		return false
	}
	return true
}

// validBranchRef validates a fully qualified branch ref without invoking Git
// while reading durable state. Git remains the authority when observing remotes.
func validBranchRef(ref string) bool {
	if !strings.HasPrefix(ref, "refs/heads/") || strings.HasSuffix(ref, ".") ||
		strings.Contains(ref, "..") || strings.Contains(ref, "@{") || strings.ContainsAny(ref, "~^:?*[\\") {
		return false
	}
	for i := 0; i < len(ref); i++ {
		if ref[i] <= 32 || ref[i] == 127 {
			return false
		}
	}
	for _, component := range strings.Split(ref, "/") {
		if component == "" || strings.HasPrefix(component, ".") || strings.HasSuffix(component, ".lock") {
			return false
		}
	}
	return true
}
