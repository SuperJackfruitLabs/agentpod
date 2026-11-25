package benchworkspace

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type remoteNamed struct {
	Name string
	Body json.RawMessage
}

type remoteCorpus struct {
	Request struct {
		Valid   map[string]json.RawMessage
		Invalid []remoteNamed
	}
	Response struct {
		Valid   map[string]json.RawMessage
		Invalid []remoteNamed
	}
}

func loadRemoteCorpus(t *testing.T) remoteCorpus {
	t.Helper()
	var c remoteCorpus
	load(t, "remote-credentials.json", &c)
	if len(c.Request.Valid) == 0 || len(c.Request.Invalid) == 0 || len(c.Response.Valid) == 0 || len(c.Response.Invalid) == 0 {
		t.Fatal("incomplete remote corpus")
	}
	return c
}

func remoteSchema(t *testing.T, name string) *jsonschema.Schema {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	// The schema's patterns are ECMA 262 (\uXXXX); the Go regexp engine spells it \x{XXXX}.
	raw = regexp.MustCompile(`\\u([0-9a-fA-F]{4})`).ReplaceAll(raw, []byte(`\x{$1}`))
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	if err = c.AddResource("remote.json", doc); err != nil {
		t.Fatal(err)
	}
	s, err := c.Compile("remote.json")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func schemaAccepts(t *testing.T, s *jsonschema.Schema, raw []byte) bool {
	t.Helper()
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	return s.Validate(inst) == nil
}

// statusFor is the HTTP status the contract pairs with a reply.
func statusFor(t *testing.T, raw []byte) int {
	t.Helper()
	var r struct {
		OK    bool
		Error struct{ Code string }
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	if r.OK {
		return 200
	}
	return map[string]int{"invalid_request": 400, "forbidden": 403, "not_found": 404, "conflict": 409, "unavailable": 503}[r.Error.Code]
}

// The contract's reply schema is closed; this client tolerates added fields.
// Those two invalid cases concern only an unknown field.
var remoteToleratedInvalid = map[string]bool{"unknown envelope field": true, "unknown result field": true}

func TestRemoteCredentialCorpus(t *testing.T) {
	c := loadRemoteCorpus(t)
	schema := remoteSchema(t, "remote-credential-response.v1.json")
	issued := 0
	for name, body := range c.Response.Valid {
		t.Run("valid/"+name, func(t *testing.T) {
			if !schemaAccepts(t, schema, body) {
				t.Fatal("fixture is not valid against its schema")
			}
			cred, err := ParseRemoteCredentialResponse(body, statusFor(t, body))
			var f *Failure
			if errors.As(err, &f) {
				if f.Code == "" || f.Uncertain {
					t.Fatal("refusal lost its code")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			issued++
			if cred.Generation == 0 || cred.ValidBefore.IsZero() || cred.WorkingDirectory == "" || cred.User == "" {
				t.Fatal("credential incomplete", cred)
			}
		})
	}
	if issued < 5 {
		t.Fatal("too few issued fixtures", issued)
	}
	for _, in := range c.Response.Invalid {
		t.Run("invalid/"+in.Name, func(t *testing.T) {
			status := statusFor(t, in.Body)
			if status == 0 {
				status = 400
			}
			_, err := ParseRemoteCredentialResponse(in.Body, status)
			if remoteToleratedInvalid[in.Name] {
				if err != nil {
					t.Fatal("added field refused", err)
				}
				return
			}
			var f *Failure
			if errors.As(err, &f) || !errors.Is(err, ErrInvalid) {
				t.Fatal("invalid reply accepted or misclassified", err)
			}
		})
	}
}

func TestRemoteCredentialToleratesAddedFields(t *testing.T) {
	c := loadRemoteCorpus(t)
	var m map[string]any
	if err := json.Unmarshal(c.Response.Valid["issued"], &m); err != nil {
		t.Fatal(err)
	}
	m["extra"] = "x"
	m["result"].(map[string]any)["added"] = 7
	raw, _ := json.Marshal(m)
	cred, err := ParseRemoteCredentialResponse(raw, 200)
	if err != nil || cred.LeaseID == "" {
		t.Fatal("added fields refused", err)
	}
}

func TestRemoteCredentialRefusesStatusMismatch(t *testing.T) {
	c := loadRemoteCorpus(t)
	if _, err := ParseRemoteCredentialResponse(c.Response.Valid["issued"], 409); !errors.Is(err, ErrInvalid) {
		t.Fatal("ok reply accepted on a 409")
	}
	if _, err := ParseRemoteCredentialResponse(c.Response.Valid["conflict"], 200); !errors.Is(err, ErrInvalid) {
		t.Fatal("refusal accepted on a 200")
	}
}

func TestRemoteCredentialRequestBytesMatchSchema(t *testing.T) {
	c := loadRemoteCorpus(t)
	schema := remoteSchema(t, "remote-credential-request.v1.json")
	for name, body := range c.Request.Valid {
		var f struct {
			Key        string `json:"key"`
			LeaseToken string `json:"lease_token"`
			PublicKey  string `json:"public_key"`
		}
		if err := json.Unmarshal(body, &f); err != nil {
			t.Fatal(err)
		}
		raw, err := RemoteCredentialRequest{Key: f.Key, LeaseToken: f.LeaseToken, PublicKey: f.PublicKey}.Bytes()
		if err != nil {
			t.Fatal(name, err)
		}
		if !schemaAccepts(t, schema, raw) {
			t.Fatal("request bytes fail the schema", name)
		}
		if len(raw) > MaxRemoteBody {
			t.Fatal("request over the bound")
		}
	}
	for _, in := range c.Request.Invalid {
		var f struct{ Key, LeaseToken, PublicKey string }
		var m map[string]any
		_ = json.Unmarshal(in.Body, &m)
		f.Key, _ = m["key"].(string)
		f.LeaseToken, _ = m["lease_token"].(string)
		f.PublicKey, _ = m["public_key"].(string)
		if schemaAccepts(t, schema, in.Body) {
			t.Fatal("schema accepts invalid fixture", in.Name)
		}
		// Whatever the caller types, a request the schema refuses is never formed.
		if raw, err := (RemoteCredentialRequest{Key: f.Key, LeaseToken: f.LeaseToken, PublicKey: f.PublicKey}).Bytes(); err == nil && !schemaAccepts(t, schema, raw) {
			t.Fatal("formed a request the schema refuses", in.Name)
		}
	}
}

const (
	remoteTestToken = "0123456789abcdef0123456789abcdef"
	remoteTestKey   = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
)

func TestRemoteCredentialNeverLogsToken(t *testing.T) {
	req := RemoteCredentialRequest{Key: "card-1", LeaseToken: remoteTestToken, PublicKey: remoteTestKey}
	for _, s := range []string{fmt.Sprint(req), fmt.Sprintf("%v %+v %#v %s", req, req, req, req), fmt.Sprint(&req)} {
		if strings.Contains(s, remoteTestToken) {
			t.Fatal("token printed", s)
		}
	}
	c := loadRemoteCorpus(t)
	for _, in := range c.Response.Invalid {
		_, err := ParseRemoteCredentialResponse(in.Body, 200)
		if err != nil && strings.Contains(err.Error(), remoteTestToken) {
			t.Fatal("token in error")
		}
	}
	// Refused locally, and refused by the producer: neither error carries the token or remote text.
	bad := req
	bad.PublicKey = "ssh-ed25519 a\nb"
	_, err := bad.Bytes()
	var f *Failure
	_, ferr := ParseRemoteCredentialResponse(c.Response.Valid["conflict"], 409)
	if !errors.As(ferr, &f) || err == nil {
		t.Fatal("expected refusals")
	}
	for _, e := range []error{err, ferr} {
		if strings.Contains(e.Error(), remoteTestToken) || strings.Contains(e.Error(), "message") {
			t.Fatal("error leaks", e)
		}
	}
}

func TestRemoteCredentialOverSocket(t *testing.T) {
	c := loadRemoteCorpus(t)
	req := RemoteCredentialRequest{Key: "card-1", LeaseToken: remoteTestToken, PublicKey: remoteTestKey}
	want, _ := req.Bytes()
	var calls atomic.Int32
	path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		sent, _ := io.ReadAll(r.Body)
		if r.URL.Path != PathRemoteCredentials || r.Method != "POST" || !bytes.Equal(sent, want) {
			t.Error("unexpected request", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			_, _ = w.Write(c.Response.Valid["issued"])
			return
		}
		w.WriteHeader(409)
		_, _ = w.Write(c.Response.Valid["conflict"])
	})
	client, err := NewClient(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	cred, err := client.RemoteCredential(t.Context(), req)
	if err != nil || cred.Generation != 3 || cred.WorkingDirectory != "/bounded/benches/card-1" ||
		!cred.ValidBefore.Equal(time.Date(2026, 11, 25, 12, 30, 0, 123456789, time.UTC)) {
		t.Fatal("credential not decoded", err, cred)
	}
	_, err = client.RemoteCredential(t.Context(), req)
	var f *Failure
	if !errors.As(err, &f) || f.Code != "conflict" {
		t.Fatal("want conflict", err)
	}
	if _, err = client.RemoteCredential(t.Context(), RemoteCredentialRequest{Key: "card-1"}); !errors.Is(err, ErrInvalid) || calls.Load() != 2 {
		t.Fatal("invalid request reached the socket", err)
	}
}

func TestRemoteExecutionID(t *testing.T) {
	id := strings.Repeat("e", 32)
	replies := map[string]string{
		"one":    `{"version":"superbench.remote.v1","operation":"remote_status","ok":true,"result":{"address":"10.0.0.5:2222","remote":[{"key":"other","execution_id":"x"},{"key":"card-1","execution_id":"` + id + `","extra":1}],"certificates":[],"sessions":[]}}`,
		"none":   `{"version":"superbench.remote.v1","operation":"remote_status","ok":true,"result":{"remote":[{"key":"other","execution_id":"x"}]}}`,
		"two":    `{"version":"superbench.remote.v1","operation":"remote_status","ok":true,"result":{"remote":[{"key":"card-1","execution_id":"a"},{"key":"card-1","execution_id":"b"}]}}`,
		"absent": `{"version":"superbench.remote.v1","operation":"remote_status","ok":true,"result":{}}`,
	}
	for name, body := range replies {
		t.Run(name, func(t *testing.T) {
			path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
				sent, _ := io.ReadAll(r.Body)
				if r.URL.Path != PathRemoteStatus || string(sent) != `{"key":"card-1","operation":"remote_status","version":"superbench.remote.v1"}` {
					t.Error("unexpected request", r.URL.Path, string(sent))
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(body))
			})
			client, err := NewClient(path, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			got, err := client.RemoteExecutionID(t.Context(), "card-1")
			switch name {
			case "one":
				if err != nil || got != id {
					t.Fatal(got, err)
				}
			case "none":
				if !errors.Is(err, ErrNoRemoteExecution) {
					t.Fatal(err)
				}
			default:
				if !errors.Is(err, ErrInvalid) {
					t.Fatal(err)
				}
			}
		})
	}
}
