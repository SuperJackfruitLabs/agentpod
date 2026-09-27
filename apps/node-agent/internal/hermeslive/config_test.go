package hermeslive

import (
	"errors"
	"strings"
	"testing"
)

// Enabling edits two keys and nothing else, and the recorded change undoes it
// back to the original bytes.
func TestEnableConfigEditsOnlyItsKeysAndReversesExactly(t *testing.T) {
	cases := map[string]struct{ before, mustContain string }{
		"no plugins section": {
			before:      "model: fixture\n# keep this comment\nplatforms:\n  - matrix\n",
			mustContain: "plugins:\n  enabled:\n    - agentpod-live\n  stream_reasoning_deltas: true\n",
		},
		"block list and entries": {
			before:      "model: fixture\nplugins:\n  enabled:\n    - other-plugin\n  disabled: []\n  entries:\n    other-plugin:\n      allow_tool_override: false\n_config_version: 45\n",
			mustContain: "    - other-plugin\n    - agentpod-live\n",
		},
		"inline list and a false flag with a comment": {
			before:      "plugins:\n  enabled: [other-plugin]\n  stream_reasoning_deltas: false  # off for now\n",
			mustContain: "enabled: [other-plugin, agentpod-live]\n  stream_reasoning_deltas: true  # off for now\n",
		},
		"empty inline list": {
			before:      "plugins:\n  enabled: []\n",
			mustContain: "enabled: [agentpod-live]",
		},
		"bare plugins key": {
			before:      "model: fixture\nplugins:\nother: 1\n",
			mustContain: "plugins:\n  enabled:\n    - agentpod-live\n  stream_reasoning_deltas: true\nother: 1\n",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			after, change, err := planEnableConfig([]byte(tc.before))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(after), tc.mustContain) {
				t.Fatalf("after:\n%s\nwant it to contain:\n%s", after, tc.mustContain)
			}
			for _, line := range strings.Split(tc.before, "\n") {
				if strings.HasPrefix(line, "#") || strings.HasPrefix(line, "_config_version") || strings.HasPrefix(line, "model") {
					if !strings.Contains(string(after), line) {
						t.Fatalf("line %q was not kept byte for byte:\n%s", line, after)
					}
				}
			}
			reverted, err := planDisableConfig(after, change)
			if err != nil {
				t.Fatal(err)
			}
			if string(reverted) != tc.before {
				t.Fatalf("reversal did not restore the original\n--- before\n%s--- reverted\n%s", tc.before, reverted)
			}
		})
	}
}

// strategy-sam's config after the manual trial: already enabled, flag already
// true. Enabling is a no-op, and a no-op records nothing to undo.
func TestEnableConfigIsANoOpWhereTheManualTrialAlreadyEnabledIt(t *testing.T) {
	before := "plugins:\n  enabled:\n    - agentpod-live\n  disabled: []\n  entries:\n    agentpod-live:\n      allow_tool_override: false\n  stream_reasoning_deltas: true\n_config_version: 45\n"
	after, change, err := planEnableConfig([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != before || change.EnabledAdded || change.StreamPrevious != "true" {
		t.Fatalf("after=%q change=%+v", after, change)
	}
	reverted, err := planDisableConfig(after, change)
	if err != nil || string(reverted) != before {
		t.Fatalf("disabling a change that added nothing must remove nothing: %q %v", reverted, err)
	}
}

func TestEnableConfigRespectsTheOperatorsDisabledList(t *testing.T) {
	_, _, err := planEnableConfig([]byte("plugins:\n  disabled:\n    - agentpod-live\n"))
	if !errors.Is(err, ErrDisabledByOperator) {
		t.Fatalf("err = %v", err)
	}
}

func TestEnableConfigRefusesShapesItCannotEditSafely(t *testing.T) {
	for _, doc := range []string{
		"plugins: [a, b]\n",
		"plugins:\n  enabled: agentpod-live\n",
		"plugins:\n  stream_reasoning_deltas: sometimes\n",
		"- just\n- a list\n",
	} {
		if _, _, err := planEnableConfig([]byte(doc)); err == nil {
			t.Errorf("accepted %q", doc)
		}
	}
}

// Disabling after the operator changed something else undoes only the plugin's
// own keys and keeps their change.
func TestDisableConfigKeepsSettingsChangedSinceEnable(t *testing.T) {
	before := "model: fixture\nplugins:\n  enabled:\n    - other-plugin\n"
	after, change, err := planEnableConfig([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(string(after), "model: fixture", "model: changed-by-operator", 1)
	reverted, err := planDisableConfig([]byte(edited), change)
	if err != nil {
		t.Fatal(err)
	}
	want := "model: changed-by-operator\nplugins:\n  enabled:\n    - other-plugin\n"
	if string(reverted) != want {
		t.Fatalf("reverted:\n%s\nwant:\n%s", reverted, want)
	}
}
