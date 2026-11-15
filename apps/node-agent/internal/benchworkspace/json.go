package benchworkspace

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
)

func strictJSON(raw []byte) bool {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if !scanValue(d, 0) {
		return false
	}
	_, err := d.Token()
	return err == io.EOF
}

func scanValue(d *json.Decoder, depth int) bool {
	if depth > 16 {
		return false
	}
	token, err := d.Token()
	if err != nil || token == nil {
		return false
	}
	switch value := token.(type) {
	case string, bool, json.Number:
		return true
	case json.Delim:
		if value != '{' && value != '[' {
			return false
		}
		seen := map[string]bool{}
		for d.More() {
			if value == '{' {
				token, err = d.Token()
				key, ok := token.(string)
				if err != nil || !ok || seen[key] {
					return false
				}
				seen[key] = true
			}
			if !scanValue(d, depth+1) {
				return false
			}
		}
		end, err := d.Token()
		return err == nil && (value == '{' && end == json.Delim('}') || value == '[' && end == json.Delim(']'))
	}
	return false
}

// encoding/json replaces lone escaped surrogates; reject them before decoding
// so different language implementations cannot select different identities.
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
			code, err := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
			if err != nil || code >= 0xdc00 && code <= 0xdfff {
				return false
			}
			if code >= 0xd800 && code <= 0xdbff {
				if i+12 > len(raw) || string(raw[i+6:i+8]) != `\u` {
					return false
				}
				low, err := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
				if err != nil || low < 0xdc00 || low > 0xdfff {
					return false
				}
				i += 6
			}
			i += 5
		}
	}
	return true
}
