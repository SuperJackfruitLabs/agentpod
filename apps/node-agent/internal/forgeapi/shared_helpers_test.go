package forgeapi

import (
	"testing"

	"go.yaml.in/yaml/v3"
)

const sharedBase = `# operator-authored: services every station needs
services:
  slack:
    kind: webhook
    host: hooks.example.com
    env_var: SLACK_HOOK
  shared-forge:
    kind: forge
    provider: forgejo
    host: pkg.example.com
    auth: token
    scheme: token
    env_var: PKG_TOKEN
    repositories: [acme/pkg]
    preset: read
`

func serviceNode(t *testing.T, policy []byte, name string) map[string]any {
	t.Helper()
	var doc struct {
		Services map[string]map[string]any `yaml:"services"`
	}
	if err := yaml.Unmarshal(policy, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Services[name]
}

func labelsOfService(t *testing.T, policy []byte, name string) map[string]any {
	t.Helper()
	n := serviceNode(t, policy, name)
	if n == nil {
		t.Fatalf("service %q missing:\n%s", name, policy)
	}
	l, _ := n["labels"].(map[string]any)
	return l
}
