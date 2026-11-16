package benchworkspace

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

var ErrResponse = errors.New("invalid workspace operation response")

type responseWire struct {
	Version   string          `json:"version"`
	Operation string          `json:"operation,omitempty"`
	RequestID string          `json:"request_id,omitempty"`
	OK        bool            `json:"ok"`
	Error     *APIError       `json:"error,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
}

// ParseResponse validates client-observable structure and operation semantics.
// It cannot prove private producer acquisition/fencing authority or global
// inventory completeness. The caller must obtain that independent evidence separately.
func ParseResponse(raw []byte, httpStatus int, request Request) (Response, error) {
	var zero Response
	if len(raw) > MaxResponse || Growth(request.Operation) && len(raw) > MaxBody || !utf8.Valid(raw) || !scalarEscapes(raw) || !strictJSON(raw) || !responseIntegers(raw) {
		return zero, ErrResponse
	}
	var wire responseWire
	if decodeResponseObject(raw, &wire) != nil {
		return zero, ErrResponse
	}
	response := Response{Version: wire.Version, Operation: wire.Operation, RequestID: wire.RequestID, OK: wire.OK, Error: wire.Error}
	if wire.Version != Version || wire.OK == (wire.Error != nil) || wire.OK && wire.Result == nil {
		return zero, ErrResponse
	}
	if wire.Error != nil && (!validOperationHTTPError(wire.Error.Code, httpStatus) || len(wire.Error.Message) == 0 || len(wire.Error.Message) > 256) {
		return zero, ErrResponse
	}
	if wire.OK && httpStatus != 200 {
		return zero, ErrResponse
	}
	if wire.Operation == "" {
		if wire.OK || wire.RequestID != "" || wire.Result != nil || !oneOf(wire.Error.Code, "invalid_request", "forbidden", "not_found", "unavailable") {
			return zero, ErrResponse
		}
		return response, nil
	}
	if !Known(request.Operation) || wire.Operation != request.Operation || wire.RequestID != request.RequestID || Growth(wire.Operation) != (wire.RequestID != "") || wire.RequestID != "" && !keyPattern.MatchString(wire.RequestID) || Growth(wire.Operation) && len(raw) > MaxBody {
		return zero, ErrResponse
	}
	if wire.Result != nil {
		if wire.Error != nil && (oneOf(wire.Error.Code, "forbidden", "in_progress") || wire.Error.Code == "operation_in_doubt" && httpStatus == 409) {
			return zero, ErrResponse
		}
		var result Result
		switch wire.Operation {
		case "status":
			result = &Status{}
		case "host_status":
			result = &HostStatus{}
		case "run":
			result = &RunOutcome{}
		case "setup":
			result = &SetupOutcome{}
		default:
			result = &Mutation{}
		}
		if decodeResponseObject(wire.Result, result) != nil {
			return zero, ErrResponse
		}
		response.Result = result
		if !validResponseResult(response, request) {
			return zero, ErrResponse
		}
	}
	return response, nil
}

// Allocation diagnostics extend ordinary operations only; cancellation keeps its
// separately reviewed closed error set.
func validOperationHTTPError(code string, status int) bool {
	if code == "capacity_exhausted" {
		return status == 422
	}
	return validHTTPError(code, status)
}

func validHTTPError(code string, status int) bool {
	switch code {
	case "invalid_request":
		return oneStatus(status, 400, 405, 413, 415)
	case "forbidden":
		return status == 403
	case "not_found":
		return status == 404
	case "conflict", "in_progress":
		return status == 409
	case "operation_in_doubt":
		return status == 409 || status == 503
	case "unavailable":
		return status == 503
	case "operation_failed":
		return status == 422
	}
	return false
}
func oneStatus(value int, choices ...int) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}
func oneOf(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}

// Every response number has one nonnegative integer spelling and is exactly
// representable by integer-aware JavaScript consumers. This rejects -0 as well
// as decimal/exponent encodings before Go can normalize those spellings.
func responseIntegers(raw []byte) bool {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	for {
		token, err := d.Token()
		if err == io.EOF {
			return true
		}
		if err != nil {
			return false
		}
		if n, ok := token.(json.Number); ok {
			value := string(n)
			if value == "" || strings.ContainsAny(value, "-.eE") {
				return false
			}
			parsed, err := strconv.ParseUint(value, 10, 64)
			if err != nil || parsed > MaxSafeInteger {
				return false
			}
		}
	}
}

func decodeResponseObject(raw []byte, target any) error {
	if !responseFields(raw, reflect.TypeOf(target).Elem()) {
		return ErrResponse
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return ErrResponse
	}
	return nil
}
func responseProperties(t reflect.Type, properties map[string]reflect.StructField) {
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		if field.Anonymous && field.Tag.Get("json") == "" {
			responseProperties(field.Type, properties)
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			properties[name] = field
		}
	}
}

// Required properties come from DTO fields without omitempty, recursively.
// This prevents absent false/zero values from acquiring invented semantics.
func responseFields(raw []byte, t reflect.Type) bool {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t == reflect.TypeOf(json.RawMessage{}) || t.Kind() == reflect.Interface {
		return true
	}
	switch t.Kind() {
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil || fields == nil {
			return false
		}
		properties := map[string]reflect.StructField{}
		responseProperties(t, properties)
		for name, field := range properties {
			value, present := fields[name]
			optional := strings.Contains(field.Tag.Get("json"), ",omitempty")
			if !present {
				if !optional {
					return false
				}
				continue
			}
			if optional && field.Type.Kind() == reflect.String && bytes.Equal(value, []byte(`""`)) {
				return false
			}
			if !responseFields(value, field.Type) {
				return false
			}
		}
		for name := range fields {
			if _, known := properties[name]; !known {
				return false
			}
		}
	case reflect.Slice:
		var values []json.RawMessage
		if json.Unmarshal(raw, &values) != nil || values == nil {
			return false
		}
		for _, value := range values {
			if !responseFields(value, t.Elem()) {
				return false
			}
		}
	}
	return true
}
