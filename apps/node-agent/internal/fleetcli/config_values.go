package fleetcli

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ValueList collects a repeated --value, in the order given. `flag` has no
// built-in repeatable string, and the alternative — one comma-separated
// --value — cannot express an entry containing a comma, which a shell command
// in an allowlist very well might. Separate from `stringList` in stations.go
// because that one refuses an empty entry with a message about station keys.
type ValueList []string

func (l *ValueList) String() string {
	if l == nil {
		return ""
	}
	return strings.Join(*l, ", ")
}

func (l *ValueList) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// DeclaredValue turns what was typed into the value PUT to the hub.
//
// The hub stores this field verbatim as jsonb and the node refuses a shape its
// registry does not expect, so getting the JSON type right is the CLI's job
// and nobody else's: a single --value could only ever produce a JSON string,
// which made every `additive-only` setting — the whole reason this feature
// exists — impossible to declare from the command line. Three forms now:
//
//   - one --value        → that string, unchanged from before
//   - several --value    → a list of strings, in the order given
//   - --json             → exactly that JSON value, whatever its type
//
// --json is also the only way to say a ONE-entry list, which is why it exists
// alongside the repeatable flag rather than instead of it.
//
// An EMPTY --value is refused, as it always was: the flag's absence and an
// explicitly empty entry used to be one condition (`*value == ""`) and both
// exited 2, and an empty string in a command allowlist, or as an approvals
// mode, is far more likely a quoting mistake than a declaration. `--json '""'`
// says it on purpose.
func DeclaredValue(values ValueList, raw string) (any, error) {
	for _, v := range values {
		if v == "" {
			return nil, fmt.Errorf("--value cannot be empty; use --json '\"\"' to declare the empty string on purpose")
		}
	}
	switch {
	case len(values) > 0 && raw != "":
		return nil, fmt.Errorf("set takes --value or --json, not both")
	case raw != "":
		var parsed any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			return nil, fmt.Errorf("--json is not valid JSON: %v", err)
		}
		return parsed, nil
	case len(values) == 1:
		return values[0], nil
	case len(values) > 1:
		return []string(values), nil
	default:
		return nil, fmt.Errorf("set requires --value (repeat it for a list) or --json")
	}
}

// Nullable turns an unset flag into a JSON null, so "not this level" and "the
// empty string" cannot arrive looking alike.
func Nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
