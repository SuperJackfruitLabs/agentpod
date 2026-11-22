package benchworkspace

import (
	"encoding/json"
	"testing"
)

type reclaimCase struct {
	Name, Kind, Raw string
	Status          int
	Body            json.RawMessage
	Expected        struct {
		Operation, Key string
		InventoryKeys  []string `json:"inventory_keys"`
	}
}

func reclaimCorpus(t *testing.T) (valid, invalid, lexical []reclaimCase) {
	t.Helper()
	var corpus struct{ Valid, Invalid, Lexical []reclaimCase }
	load(t, "reclaim.json", &corpus)
	if len(corpus.Valid) == 0 || len(corpus.Invalid) == 0 || len(corpus.Lexical) == 0 {
		t.Fatal("incomplete reclaim corpus")
	}
	return corpus.Valid, corpus.Invalid, corpus.Lexical
}

// AgentPod reclaims a bench only once the hub has settled its card (benchbridge.Reclaim). The
// codec forms exactly the corpus's valid request, key only, and refuses every other reclaim request.
func TestReclaimRequestIsKeyOnly(t *testing.T) {
	valid, invalid, lexical := reclaimCorpus(t)
	formed := 0
	for i, group := range [][]reclaimCase{valid, invalid, lexical} {
		for _, c := range group {
			if c.Kind != "request" {
				continue
			}
			raw := []byte(c.Body)
			if c.Raw != "" {
				raw = []byte(c.Raw)
			}
			_, err := Parse(raw)
			if i == 0 && err != nil {
				t.Fatal("valid reclaim request refused", c.Name, err)
			}
			if i > 0 && err == nil {
				t.Fatal("invalid reclaim request accepted", c.Name)
			}
			if err == nil {
				formed++
			}
		}
	}
	if formed != 1 || !Known("reclaim") || Growth("reclaim") || ReadOnly("reclaim") {
		t.Fatal("reclaim is not exactly one key-only operator request")
	}
}

func TestReclaimResponsesAndPhases(t *testing.T) {
	valid, invalid, lexical := reclaimCorpus(t)
	request := func(c reclaimCase) Request {
		return Request{Version: Version, Operation: c.Expected.Operation, Key: c.Expected.Key}
	}
	phases := map[string]bool{}
	for _, c := range valid {
		if c.Kind != "response" {
			continue
		}
		t.Run("valid/"+c.Name, func(t *testing.T) {
			reply, err := ParseResponse(c.Body, c.Status, request(c))
			if err != nil {
				t.Fatal(err)
			}
			if s, ok := reply.Result.(*Status); ok {
				if len(s.Benches) != len(c.Expected.InventoryKeys) {
					t.Fatal("inventory changed")
				}
				for i, b := range s.Benches {
					if inventoryKey(b) != c.Expected.InventoryKeys[i] {
						t.Fatal("inventory key changed")
					}
					if w, ok := b.(*WorkspaceInventory); ok {
						phases[w.Phase] = true
						if w.ReadyForAcquisition || w.Lease != nil || w.Checkpoint == nil {
							t.Fatal("reclaim phase offered a bench")
						}
					}
				}
			}
		})
	}
	if !phases["reclaiming"] || !phases["reclaimed"] {
		t.Fatal("status corpus no longer covers both reclaim phases")
	}
	for _, c := range invalid {
		if c.Kind != "response" {
			continue
		}
		t.Run("invalid/"+c.Name, func(t *testing.T) {
			if _, err := ParseResponse(c.Body, c.Status, request(c)); err == nil {
				t.Fatal("invalid reclaim response accepted")
			}
		})
	}
	for _, c := range lexical {
		if c.Kind != "response" {
			continue
		}
		t.Run("lexical/"+c.Name, func(t *testing.T) {
			if _, err := ParseResponse([]byte(c.Raw), 200, Request{Version: Version, Operation: "reclaim", Key: "card"}); err == nil {
				t.Fatal("ambiguous reclaim response accepted")
			}
		})
	}
}

func TestReclaimLifecycleNamesOnlyCorpusCases(t *testing.T) {
	valid, _, _ := reclaimCorpus(t)
	names := map[string]bool{}
	for _, c := range valid {
		names[c.Name] = true
	}
	var lifecycle struct {
		Scenarios []struct {
			Name         string
			ResponseCase string `json:"response_case"`
			Steps        []struct {
				RequestCase  string `json:"request_case"`
				ResponseCase string `json:"response_case"`
			}
		}
	}
	load(t, "reclaim-lifecycle.json", &lifecycle)
	found := false
	for _, s := range lifecycle.Scenarios {
		found = found || s.Name == "create-after-reclaim"
		for _, name := range []string{s.ResponseCase} {
			if !names[name] {
				t.Fatal("scenario names an unknown case", s.Name, name)
			}
		}
		for _, step := range s.Steps {
			for _, name := range []string{step.RequestCase, step.ResponseCase} {
				if name != "" && !names[name] {
					t.Fatal("step names an unknown case", s.Name, name)
				}
			}
		}
	}
	if !found {
		t.Fatal("create-after-reclaim scenario missing")
	}
}
