package descriptor

import "testing"

func TestYamlScalar(t *testing.T) {
	doc := []byte(`
# a comment
gateway:
  multiplex_profiles: true
approvals:
  mode: ask
  timeout: 900   # seconds
  command_allowlist:
    - ls
model:
  timeout: 5
`)
	cases := []struct {
		name, section, key, want string
		found                    bool
	}{
		{"a scalar in its section", "approvals", "timeout", "900", true},
		{"a comment after the value is not part of it", "approvals", "mode", "ask", true},
		{"a key in another section does not leak", "gateway", "timeout", "", false},
		{"the same key in two sections stays distinct", "model", "timeout", "5", true},
		{"a missing section", "nope", "timeout", "", false},
		{"a missing key in a present section", "approvals", "nope", "", false},
		{"a list-valued key is not a scalar", "approvals", "command_allowlist", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, found := yamlScalar(doc, c.section, c.key)
			if found != c.found || got != c.want {
				t.Fatalf("yamlScalar(%q,%q) = %q,%v; want %q,%v", c.section, c.key, got, found, c.want, c.found)
			}
		})
	}
}

func TestYamlScalarQuotedAndUnreadable(t *testing.T) {
	if got, _ := yamlScalar([]byte("approvals:\n  mode: \"ask\"\n"), "approvals", "mode"); got != "ask" {
		t.Fatalf("quotes should be trimmed, got %q", got)
	}
	// Not a parser: a document with no sections simply finds nothing. The CALLER
	// decides whether "not found" means unreadable — see hermes_config.go.
	if _, found := yamlScalar([]byte("just a line\n"), "approvals", "mode"); found {
		t.Fatal("a document with no section should find nothing")
	}
}
