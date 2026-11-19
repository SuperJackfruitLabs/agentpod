package benchworkspace

import (
	"encoding/json"
	"testing"
)

// The contract: a specific-key status returns exactly that key's record or
// not_found. Only that not_found is absence. The error bodies come from the
// shared response corpus, readdressed to a status.
func TestKeyAbsentIsOnlyASpecificKeyNotFound(t *testing.T) {
	var corpus struct {
		Valid []struct {
			Name   string
			Status int
			Body   map[string]any
		}
	}
	load(t, "workspace-responses.json", &corpus)
	reply := func(name, operation string, request Request) Response {
		t.Helper()
		for _, c := range corpus.Valid {
			if c.Name == name {
				c.Body["operation"] = operation
				if operation == "" {
					delete(c.Body, "operation")
				}
				delete(c.Body, "request_id")
				raw, _ := json.Marshal(c.Body)
				r, err := ParseResponse(raw, c.Status, request)
				if err != nil {
					t.Fatal(name, operation, err)
				}
				return r
			}
		}
		t.Fatal("corpus case missing", name)
		return Response{}
	}
	key := Request{Version: Version, Operation: "status", Key: "card"}
	global := Request{Version: Version, Operation: "status"}
	if !KeyAbsent(key, reply("error-404-not_found", "status", key)) {
		t.Fatal("specific-key not_found is absence")
	}
	for name, c := range map[string]struct {
		request Request
		reply   Response
	}{
		"unavailable":          {key, reply("error-503-unavailable", "status", key)},
		"not_found off-route":  {key, reply("error-404-not_found", "", key)},
		"global status":        {global, reply("error-404-not_found", "status", global)},
		"found (empty answer)": {key, Response{Version: Version, Operation: "status", OK: true, Result: &Status{}}},
	} {
		if KeyAbsent(c.request, c.reply) {
			t.Fatal(name, "was read as absence")
		}
	}
}
