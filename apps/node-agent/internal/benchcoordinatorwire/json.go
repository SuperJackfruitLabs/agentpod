package benchcoordinatorwire

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"
)

var ErrInvalid = errors.New("coordinator data refused")

// lexical validates raw bytes before encoding/json can replace invalid Unicode,
// discard duplicate keys, accept null zero values, or normalize numeric lexemes.
func lexical(raw []byte, limit int) error {
	if len(raw) > limit || !utf8.Valid(raw) {
		return ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 64 {
			return ErrInvalid
		}
		t, e := d.Token()
		if e != nil {
			return ErrInvalid
		}
		switch v := t.(type) {
		case json.Delim:
			switch v {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					k, e := d.Token()
					s, ok := k.(string)
					if e != nil || !ok || seen[s] {
						return ErrInvalid
					}
					seen[s] = true
					if walk(depth+1) != nil {
						return ErrInvalid
					}
				}
				end, e := d.Token()
				if e != nil || end != json.Delim('}') {
					return ErrInvalid
				}
			case '[':
				for d.More() {
					if walk(depth+1) != nil {
						return ErrInvalid
					}
				}
				end, e := d.Token()
				if e != nil || end != json.Delim(']') {
					return ErrInvalid
				}
			default:
				return ErrInvalid
			}
		case nil:
			return ErrInvalid
		case json.Number:
			s := string(v)
			if strings.ContainsAny(s, "-.eE+") {
				return ErrInvalid
			}
			n, e := strconv.ParseUint(s, 10, 64)
			if e != nil || n > 9007199254740991 {
				return ErrInvalid
			}
		}
		return nil
	}
	if walk(0) != nil {
		return ErrInvalid
	}
	if _, e := d.Token(); e != io.EOF {
		return ErrInvalid
	}
	// JSON permits isolated escaped surrogates; encoding/json silently replaces
	// them. Inspect each raw string's escapes independently, including object keys.
	for p := 0; p < len(raw); p++ {
		if raw[p] != '"' {
			continue
		}
		p++
		for p < len(raw) && raw[p] != '"' {
			if raw[p] != '\\' {
				p++
				continue
			}
			p++
			if p >= len(raw) {
				return ErrInvalid
			}
			if raw[p] != 'u' {
				p++
				continue
			}
			if p+4 >= len(raw) {
				return ErrInvalid
			}
			n, e := strconv.ParseUint(string(raw[p+1:p+5]), 16, 16)
			if e != nil {
				return ErrInvalid
			}
			p += 5
			if n >= 0xdc00 && n <= 0xdfff {
				return ErrInvalid
			}
			if n >= 0xd800 && n <= 0xdbff {
				if p+5 >= len(raw) || raw[p] != '\\' || raw[p+1] != 'u' {
					return ErrInvalid
				}
				low, e := strconv.ParseUint(string(raw[p+2:p+6]), 16, 16)
				if e != nil || low < 0xdc00 || low > 0xdfff {
					return ErrInvalid
				}
				p += 6
			}
		}
	}
	return nil
}
func decode(raw []byte, limit int, out any) error {
	if lexical(raw, limit) != nil {
		return ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return ErrInvalid
	}
	if !shape(raw, reflect.TypeOf(out).Elem()) {
		return ErrInvalid
	}
	return nil
}
func fields(raw []byte, names ...string) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || len(m) != len(names) {
		return false
	}
	for _, n := range names {
		if _, ok := m[n]; !ok {
			return false
		}
	}
	return true
}

func shape(raw []byte, t reflect.Type) bool {
	if t.Kind() == reflect.Pointer {
		return shape(raw, t.Elem())
	}
	if t.Kind() == reflect.Struct {
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			return false
		}
		allowed := make(map[string]bool, t.NumField())
		for i := 0; i < t.NumField(); i++ {
			allowed[strings.Split(t.Field(i).Tag.Get("json"), ",")[0]] = true
		}
		for key := range m {
			if !allowed[key] {
				return false
			}
		}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			tag := strings.Split(f.Tag.Get("json"), ",")
			v, ok := m[tag[0]]
			optional := len(tag) > 1 && tag[1] == "omitempty"
			if !ok {
				if !optional {
					return false
				}
				continue
			}
			if optional && f.Type.Kind() == reflect.String && string(v) == `""` {
				return false
			}
			if !shape(v, f.Type) {
				return false
			}
		}
	} else if t.Kind() == reflect.Slice {
		var a []json.RawMessage
		if json.Unmarshal(raw, &a) != nil {
			return false
		}
		for _, v := range a {
			if !shape(v, t.Elem()) {
				return false
			}
		}
	}
	return true
}
