package benchcoordinatorwire

import (
	"encoding/json"
	"unicode/utf8"
)

// wireSize matches JSON.stringify UTF-8 length, including literal HTML and
// U+2028/U+2029, rather than Go's additional HTML-safe escapes.
func wireSize(v any) (int, error) {
	raw, e := json.Marshal(v)
	if e != nil {
		return 0, ErrInvalid
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil {
		return 0, ErrInvalid
	}
	var size func(any) int
	stringSize := func(s string) int {
		n := 2
		for _, r := range s {
			switch r {
			case '"', '\\', '\b', '\f', '\n', '\r', '\t':
				n += 2
			default:
				if r < 32 {
					n += 6
				} else {
					n += utf8.RuneLen(r)
				}
			}
		}
		return n
	}
	size = func(v any) int {
		switch x := v.(type) {
		case string:
			return stringSize(x)
		case map[string]any:
			n := 2
			for k, v := range x {
				n += stringSize(k) + 1 + size(v) + 1
			}
			if len(x) > 0 {
				n--
			}
			return n
		case []any:
			n := 2
			for _, v := range x {
				n += size(v) + 1
			}
			if len(x) > 0 {
				n--
			}
			return n
		default:
			b, _ := json.Marshal(x)
			return len(b)
		}
	}
	return size(decoded), nil
}
