package fleetcli

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

func Refuse(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(2)
}

// ParseForgeRule reads "allow: POST /repos/o/r/issues" into {"allow": "POST /repos/o/r/issues"}.
func ParseForgeRule(s string) (map[string]any, bool) {
	kind, rest, ok := strings.Cut(s, ":")
	kind, rest = strings.TrimSpace(kind), strings.TrimSpace(rest)
	if !ok || (kind != "allow" && kind != "deny") {
		return nil, false
	}
	method, path, ok := strings.Cut(rest, " ")
	path = strings.TrimSpace(path)
	if !ok || method == "" || method != strings.ToUpper(method) || !strings.HasPrefix(path, "/") {
		return nil, false
	}
	return map[string]any{kind: method + " " + path}, true
}

const forgeCredentialMax = 64 * 1024

// ForgeSealedMax is the hub's cap on a supplied/app envelope (contract FORGE_API_SEALED_MAX, held
// to it by TestForgeSealedMaxMatchesTheContract). Checked after sealing and before the grant exists.
const ForgeSealedMax = 16384

// ReadForgeCredential reads the credential from stdin. Errors never quote what was read.
func ReadForgeCredential(mode string) map[string]string {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, forgeCredentialMax+1))
	if err != nil {
		Refuse("could not read the credential from stdin")
	}
	if len(raw) > forgeCredentialMax {
		Refuse("the credential on stdin is larger than 64 KiB")
	}
	text := strings.TrimSpace(string(raw))
	if text == "" {
		Refuse("--mode %s reads the credential from stdin, and stdin was empty", mode)
	}
	if mode != "app" {
		if strings.ContainsAny(text, "\r\n \t") {
			Refuse("a supplied token is one line with no spaces; stdin had more")
		}
		return map[string]string{"token": text}
	}
	m := map[string]string{}
	last := ""
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 0, 4096), forgeCredentialMax)
	for sc.Scan() {
		line := sc.Text()
		if k, v, ok := strings.Cut(line, "="); ok && (k == "app_id" || k == "installation_id" || k == "private_key") {
			if _, dup := m[k]; dup {
				Refuse("stdin names %s twice", k)
			}
			m[k], last = strings.TrimSpace(v), k
			continue
		}
		if last != "private_key" {
			Refuse("an app credential is the lines app_id=…, installation_id=… and private_key=… on stdin")
		}
		m[last] += "\n" + line
	}
	for _, k := range []string{"app_id", "installation_id", "private_key"} {
		if m[k] == "" {
			Refuse("the app credential on stdin lacks %s=…", k)
		}
	}
	m["private_key"] = strings.TrimSpace(m["private_key"])
	return m
}

// CheckEnvelope refuses to send anything that is not a sealed envelope. Its message is fixed: it
// never quotes the value, which could be plaintext if the sealer were ever wrong.
func CheckEnvelope(s string) error {
	if !strings.HasPrefix(s, handoverEnvelopePrefix) {
		return fmt.Errorf("sealing did not produce a sealed envelope; nothing was sent")
	}
	return nil
}

const handoverEnvelopePrefix = "stk-handover-v1:"

// ForgeGrantRow is every field `list` prints. Only these are decoded, so a field the CLI does not
// know — even one a faulty hub should never send — is never printed.
type ForgeGrantRow struct {
	ID           string   `json:"id"`
	Provider     string   `json:"provider"`
	Instance     string   `json:"instance"`
	Mode         string   `json:"mode"`
	Account      string   `json:"account"`
	Repositories []string `json:"repositories"`
	Preset       string   `json:"preset"`
	State        string   `json:"state"`
	StateReason  *string  `json:"stateReason"`
	Isolation    *string  `json:"isolation"`
	Rotation     *string  `json:"rotation"`
}
