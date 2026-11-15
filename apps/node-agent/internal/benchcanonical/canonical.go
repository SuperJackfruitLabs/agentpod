// Package benchcanonical implements the proposed owner's source digest codec.
// Callers must independently validate the complete producer request/response.
package benchcanonical

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

var ErrInvalid = errors.New("invalid proposed canonical evidence")

type Digests struct {
	SourceRequestSHA256 string `json:"source_request_sha256"`
	SourceReceiptSHA256 string `json:"source_receipt_sha256,omitempty"`
}

func Canonical(raw []byte) ([]byte, error) {
	value, e := read(raw)
	if e != nil {
		return nil, ErrInvalid
	}
	return canonical(value)
}
func Digest(raw []byte) (string, error) {
	value, e := Canonical(raw)
	if e != nil {
		return "", e
	}
	h := sha256.Sum256(value)
	return hex.EncodeToString(h[:]), nil
}
func ReceiptDigest(raw []byte) (string, error) {
	decoded, e := read(raw)
	if e != nil {
		return "", ErrInvalid
	}
	value, ok := decoded.(map[string]any)
	if !ok || value["ok"] != true {
		return "", ErrInvalid
	}
	result, ok := value["result"].(map[string]any)
	if !ok {
		return "", ErrInvalid
	}
	delete(result, "root_path")
	delete(result, "grant")
	b, e := canonical(value)
	if e != nil {
		return "", ErrInvalid
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func read(raw []byte) (any, error) {
	if len(raw) > 1<<20 || !utf8.Valid(raw) || !scalarEscapes(raw) {
		return nil, ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	value, e := readValue(d, 0)
	if e != nil {
		return nil, ErrInvalid
	}
	if _, e = d.Token(); !errors.Is(e, io.EOF) {
		return nil, ErrInvalid
	}
	return value, nil
}
func integer(value json.Number) bool {
	s := string(value)
	if s == "" || len(s) > 1 && s[0] == '0' {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, e := strconv.ParseUint(s, 10, 64)
	return e == nil && n <= 1<<53-1
}
func readValue(d *json.Decoder, depth int) (any, error) {
	if depth > 128 {
		return nil, ErrInvalid
	}
	token, e := d.Token()
	if e != nil || token == nil {
		return nil, ErrInvalid
	}
	switch value := token.(type) {
	case string, bool:
		return value, nil
	case json.Number:
		if integer(value) {
			return value, nil
		}
	case json.Delim:
		switch value {
		case '{':
			object := map[string]any{}
			for d.More() {
				key, e := d.Token()
				name, ok := key.(string)
				if e != nil || !ok {
					return nil, ErrInvalid
				}
				for _, c := range name {
					if c > 127 {
						return nil, ErrInvalid
					}
				}
				if _, exists := object[name]; exists {
					return nil, ErrInvalid
				}
				item, e := readValue(d, depth+1)
				if e != nil {
					return nil, e
				}
				object[name] = item
			}
			if close, e := d.Token(); e == nil && close == json.Delim('}') {
				return object, nil
			}
		case '[':
			array := []any{}
			for d.More() {
				item, e := readValue(d, depth+1)
				if e != nil {
					return nil, e
				}
				array = append(array, item)
			}
			if close, e := d.Token(); e == nil && close == json.Delim(']') {
				return array, nil
			}
		}
	}
	return nil, ErrInvalid
}
func quote(out *bytes.Buffer, text string) {
	out.WriteByte('"')
	for _, c := range text {
		if c == '"' || c == '\\' {
			out.WriteByte('\\')
			out.WriteRune(c)
		} else if c >= 32 && c <= 126 {
			out.WriteRune(c)
		} else if c > 0xffff {
			high, low := utf16.EncodeRune(c)
			_, _ = fmt.Fprintf(out, `\u%04x\u%04x`, high, low)
		} else {
			_, _ = fmt.Fprintf(out, `\u%04x`, c)
		}
	}
	out.WriteByte('"')
}
func canonical(value any) ([]byte, error) {
	var out bytes.Buffer
	var encode func(any) error
	encode = func(value any) error {
		switch v := value.(type) {
		case string:
			quote(&out, v)
		case bool:
			out.WriteString(strconv.FormatBool(v))
		case json.Number:
			if !integer(v) {
				return ErrInvalid
			}
			out.WriteString(string(v))
		case []any:
			out.WriteByte('[')
			for i, item := range v {
				if i > 0 {
					out.WriteByte(',')
				}
				if e := encode(item); e != nil {
					return e
				}
			}
			out.WriteByte(']')
		case map[string]any:
			keys := make([]string, 0, len(v))
			for key := range v {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			out.WriteByte('{')
			for i, key := range keys {
				if i > 0 {
					out.WriteByte(',')
				}
				quote(&out, key)
				out.WriteByte(':')
				if e := encode(v[key]); e != nil {
					return e
				}
			}
			out.WriteByte('}')
		default:
			return ErrInvalid
		}
		return nil
	}
	if e := encode(value); e != nil {
		return nil, e
	}
	return out.Bytes(), nil
}

// Reject lone UTF-16 escapes before encoding/json can replace their identity.
func scalarEscapes(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '"' {
			continue
		}
		for i++; i < len(raw) && raw[i] != '"'; i++ {
			if raw[i] != '\\' {
				continue
			}
			if i+1 >= len(raw) {
				return false
			}
			if raw[i+1] != 'u' {
				i++
				continue
			}
			if i+6 > len(raw) {
				return false
			}
			code, e := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
			if e != nil || code >= 0xdc00 && code <= 0xdfff {
				return false
			}
			if code >= 0xd800 && code <= 0xdbff {
				if i+12 > len(raw) || string(raw[i+6:i+8]) != `\u` {
					return false
				}
				low, e := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
				if e != nil || low < 0xdc00 || low > 0xdfff {
					return false
				}
				i += 6
			}
			i += 5
		}
	}
	return true
}
