package benchcoordinatorwire

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedCurrentDecisionCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-current-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Requests []struct {
			Name   string
			Accept bool
			Value  json.RawMessage
		}
		Responses []struct {
			Name       string
			Accept     bool
			RequestRaw string `json:"request_raw"`
			NowMs      int64  `json:"now_ms"`
			Value      json.RawMessage
		}
		Lexical []struct{ Name, Raw string }
	}
	if err = json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Requests) < 8 || len(corpus.Responses) < 9 || len(corpus.Lexical) < 4 {
		t.Fatal("current corpus missing boundary coverage")
	}
	for _, c := range corpus.Requests {
		t.Run("request/"+c.Name, func(t *testing.T) {
			_, err := ParseCurrentRequest(c.Value)
			if (err == nil) != c.Accept {
				t.Fatalf("accept=%t, err=%v", c.Accept, err)
			}
		})
	}
	for _, c := range corpus.Responses {
		t.Run("response/"+c.Name, func(t *testing.T) {
			_, err := ParseCurrentResponse(c.Value, []byte(c.RequestRaw), c.NowMs)
			if (err == nil) != c.Accept {
				t.Fatalf("accept=%t, err=%v", c.Accept, err)
			}
		})
	}
	for _, c := range corpus.Lexical {
		t.Run("lexical/"+c.Name, func(t *testing.T) {
			if _, err := ParseCurrentRequest([]byte(c.Raw)); err == nil {
				t.Fatal("ambiguous current request accepted")
			}
		})
	}
}
