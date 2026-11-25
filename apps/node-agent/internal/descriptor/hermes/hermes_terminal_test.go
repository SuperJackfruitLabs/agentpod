package hermes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

var testSSH = SSHTerminal{Host: "100.64.0.1", Port: 2222, User: "b-0123456789abcdef0123456789abcdef",
	KeyPath: "/etc/agentpod/bench-identities/st_1", Cwd: "/srv/benches/card-7"}

func writeProfile(t *testing.T, config string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(config), 0o640); err != nil {
		t.Fatal(err)
	}
	return dir
}

func readProfile(t *testing.T, dir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// The six keys, as Hermes would read them.
func terminalOf(t *testing.T, config string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(config), &doc); err != nil {
		t.Fatalf("config does not parse: %v\n%s", err, config)
	}
	term, _ := doc["terminal"].(map[string]any)
	return term
}

// The prior goes through the journal as JSON; round-trip it the same way.
func viaJSON(t *testing.T, prior map[string]any) map[string]any {
	t.Helper()
	data, err := json.Marshal(prior)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

var terminalFixtures = map[string]string{
	"no terminal section": "# operator's profile\nmodel:\n  default: kimi-for-coding  # pinned\n\nplugins:\n  enabled: [agentpod-live]\n",
	"no trailing newline": "model:\n  default: kimi\ndisplay:\n  personality: calm",
	"empty file":          "",
	"bare terminal":       "model:\n  default: kimi\nterminal:\napprovals:\n  mode: ask\n",
	"terminal with comments and quoting": "# top comment\nterminal:\n  # how commands run\n  backend: \"local\"   # the default\n" +
		"  timeout: 180\n  cwd: '.'\n  ssh_port: 22 # unused\n  persistent_shell: true\n\n# trailing section\nmemory:\n  enabled: true\n",
}

func TestTerminalSetSSHWritesTheSixKeysAndRestoresExactly(t *testing.T) {
	for name, before := range terminalFixtures {
		t.Run(name, func(t *testing.T) {
			dir := writeProfile(t, before)
			prior, err := HermesTerminal{}.SetSSH(dir, testSSH)
			if err != nil {
				t.Fatalf("SetSSH: %v", err)
			}
			attached := readProfile(t, dir)
			term := terminalOf(t, attached)
			want := map[string]any{"backend": "ssh", "ssh_host": testSSH.Host, "ssh_port": 2222, "ssh_user": testSSH.User,
				"ssh_key": testSSH.KeyPath, "cwd": testSSH.Cwd}
			for k, v := range want {
				if !reflect.DeepEqual(term[k], v) {
					t.Errorf("terminal.%s = %#v, want %#v\n%s", k, term[k], v, attached)
				}
			}
			if strings.Contains(before, "# how commands run") && !strings.Contains(attached, "# how commands run") {
				t.Errorf("a comment was lost:\n%s", attached)
			}
			changed, err := HermesTerminal{}.Restore(dir, testSSH, viaJSON(t, prior))
			if err != nil || changed {
				t.Fatalf("Restore: changed=%v err=%v", changed, err)
			}
			if after := readProfile(t, dir); after != before {
				t.Fatalf("restore is not byte-exact:\nbefore %q\nafter  %q", before, after)
			}
		})
	}
}

func TestTerminalRestoreKeepsAnEditElsewhere(t *testing.T) {
	before := terminalFixtures["terminal with comments and quoting"]
	dir := writeProfile(t, before)
	prior, err := HermesTerminal{}.SetSSH(dir, testSSH)
	if err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(readProfile(t, dir), "  enabled: true\n", "  enabled: false\n", 1)
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(edited), 0o640); err != nil {
		t.Fatal(err)
	}
	if changed, err := (HermesTerminal{}).Restore(dir, testSSH, viaJSON(t, prior)); err != nil || changed {
		t.Fatalf("Restore: changed=%v err=%v", changed, err)
	}
	want := strings.Replace(before, "  enabled: true\n", "  enabled: false\n", 1)
	if got := readProfile(t, dir); got != want {
		t.Fatalf("restore lost the edit elsewhere or left ours:\n%s", got)
	}
}

func TestTerminalRestoreLeavesAnOperatorsTerminalAlone(t *testing.T) {
	dir := writeProfile(t, terminalFixtures["no terminal section"])
	prior, err := HermesTerminal{}.SetSSH(dir, testSSH)
	if err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(readProfile(t, dir), "backend: ssh", "backend: docker", 1)
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(edited), 0o640); err != nil {
		t.Fatal(err)
	}
	changed, err := HermesTerminal{}.Restore(dir, testSSH, viaJSON(t, prior))
	if err != nil || !changed {
		t.Fatalf("Restore: changed=%v err=%v, want changed", changed, err)
	}
	if got := readProfile(t, dir); got != edited {
		t.Fatalf("an operator's terminal was rewritten:\n%s", got)
	}
}

func TestTerminalSetSSHRefusesAShapeItCannotEdit(t *testing.T) {
	for _, config := range []string{"terminal: {backend: local}\n", "terminal: local\n", "terminal:\n  cwd: |\n    /a\n"} {
		dir := writeProfile(t, config)
		if _, err := (HermesTerminal{}).SetSSH(dir, testSSH); err == nil {
			t.Errorf("SetSSH accepted %q", config)
		}
		if got := readProfile(t, dir); got != config {
			t.Errorf("a refused SetSSH wrote %q", got)
		}
	}
}

func TestTerminalInspectNamesCredentialMounts(t *testing.T) {
	dir := writeProfile(t, "terminal:\n  backend: docker\n  credential_files:\n    - .env\n")
	skill := filepath.Join(dir, "skills", "deploy")
	if err := os.MkdirAll(skill, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: deploy\nrequired_credential_files:\n  - path: kube.conf\n---\nbody\n"), 0o644)
	plain := filepath.Join(dir, "skills", "notes")
	_ = os.MkdirAll(plain, 0o755)
	_ = os.WriteFile(filepath.Join(plain, "SKILL.md"), []byte("---\nname: notes\nrequired_credential_files: []\n---\n"), 0o644)

	got, err := HermesTerminal{}.Inspect(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Backend != "docker" {
		t.Errorf("backend = %q", got.Backend)
	}
	want := []string{"terminal.credential_files is set", "skill deploy declares required_credential_files"}
	if !reflect.DeepEqual(got.CredentialMounts, want) {
		t.Errorf("credential mounts = %q, want %q", got.CredentialMounts, want)
	}

	clean := writeProfile(t, "terminal:\n  credential_files: []\n")
	if got, _ := (HermesTerminal{}).Inspect(clean); len(got.CredentialMounts) != 0 || got.Backend != "" {
		t.Errorf("a clean profile reports %+v", got)
	}
}

func TestBenchStateIsPrivateAndRemovable(t *testing.T) {
	dir := t.TempDir()
	if err := (HermesTerminal{}).WriteState(dir, BenchState{BenchID: "abc", WorkingDirectory: "/srv/b"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, BenchStateFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("state file: %v %v", info, err)
	}
	if err := (HermesTerminal{}).RemoveState(dir); err != nil {
		t.Fatal(err)
	}
	if err := (HermesTerminal{}).RemoveState(dir); err != nil {
		t.Fatalf("removing an absent state: %v", err)
	}
}
