package salaam

import (
	"context"
	"encoding/json"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/mcpproxy"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPFingerprintsMatchJavaScriptForUnicodeWorkspacesAndLiteralEscapes(t *testing.T) {
	value := map[string]string{"station": "s", "workspace": "/work/树🌿\u2028/literal\\u2028"}
	// SHA-256(JSON.stringify(value)) on the pinned Node26.7.0 producer.
	if canonicalDigest(value) != "1ce33b7118e87b63d2b1e111bc0a2b84ee9cd0a44e67231af57b6ac56fdfcee4" {
		t.Fatal("Unicode workspace fingerprint differs from the daemon")
	}
}

func TestSharedPrivateMCPAssignmentCorpus(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contract", "src", "fixtures", "salaam-mcp-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Assignments []struct {
			Name   string          `json:"name"`
			Value  json.RawMessage `json:"value"`
			Accept bool            `json:"accept"`
		} `json:"assignments"`
	}
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, row := range corpus.Assignments {
		t.Run(row.Name, func(t *testing.T) {
			var assignment MCPAssignment
			err := json.Unmarshal(row.Value, &assignment)
			if err == nil {
				err = assignment.Validate()
			}
			if (err == nil) != row.Accept {
				t.Fatalf("assignment acceptance=%v, want %v", err == nil, row.Accept)
			}
		})
	}
}

func TestSharedSafeMCPAdmissionCorpus(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contract", "src", "fixtures", "salaam-mcp-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Admissions []struct {
			Name   string          `json:"name"`
			Value  json.RawMessage `json:"value"`
			Accept bool            `json:"accept"`
		} `json:"admissions"`
	}
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Admissions) == 0 {
		t.Fatal("missing canonical admission cases")
	}
	for _, row := range corpus.Admissions {
		t.Run(row.Name, func(t *testing.T) {
			var view MCPView
			err := json.Unmarshal(row.Value, &view)
			if err == nil {
				err = view.Validate()
			}
			if (err == nil) != row.Accept {
				t.Fatalf("receipt acceptance=%v, want %v", err == nil, row.Accept)
			}
		})
	}
}

func TestPrivateAssignmentGoesToDaemonAndOnlyVerifiedPublicDeclarationsReturn(t *testing.T) {
	data, _ := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contract", "src", "fixtures", "salaam-mcp-v1.json"))
	// Decode only the accepted fixture, rather than unmarshalling intentional negative rows.
	var raw struct {
		Assignments []struct {
			Value json.RawMessage `json:"value"`
		} `json:"assignments"`
	}
	_ = json.Unmarshal(data, &raw)
	var assignment MCPAssignment
	if err := json.Unmarshal(raw.Assignments[0].Value, &assignment); err != nil {
		t.Fatal(err)
	}
	servers := assignment.Servers
	servers[0].CredentialGeneration = assignment.CredentialGeneration
	b := assignment.Binding
	var forwarded []byte
	mismatch := false
	c := &Client{NodeID: b.NodeID, Workspace: b.Workspace, HTTP: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		if r.Method == "GET" {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"service":"healthy","managed_mcp":{"profile_digest":"` + assignment.ProfileDigest + `"}}`))}, nil
		}
		if strings.HasSuffix(r.URL.Path, "/status") {
			body, _ := json.Marshal(map[string]any{"binding": b, "authorized": true, "admission_id": "admission", "session_id": "session"})
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		}
		forwarded, _ = io.ReadAll(r.Body)
		receipt := MCPView{Version: 1, ProfileDigest: assignment.ProfileDigest, AssignmentDigest: canonicalDigest(assignment), BindingDigest: canonicalDigest(b), CredentialGeneration: assignment.CredentialGeneration,
			Servers: []MCPServerView{{Name: servers[0].Name, EndpointDigest: canonicalDigest(servers[0].URL), CatalogDigest: strings.Repeat("b", 64), Tools: []MCPToolPin{{Name: "library_search", SchemaDigest: strings.Repeat("c", 64), Policy: "read"}}}}}
		if mismatch {
			receipt.CredentialGeneration++
		}
		payload, _ := json.Marshal(receipt)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(payload)))}, nil
	})}}
	c.BindMCP = func(station string, identity mcpproxy.Identity) ([]mcpproxy.Server, error) {
		if station != b.StationID || identity.BindingDigest != canonicalDigest(b) || identity.PrincipalID != b.PrincipalID || identity.OrganizationID != b.OrganizationID || identity.OccupancyEpoch != b.OccupancyEpoch {
			t.Fatal("proxy identity lost its admitted root binding")
		}
		return servers, nil
	}
	public, err := c.AssignMCP(context.Background(), b, servers)
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := json.Marshal(public)
	if len(public) != 1 || len(public[0].Headers) != 0 || strings.Contains(string(wire), servers[0].Headers[0].Value) {
		t.Fatal("private proxy credential left the control path")
	}
	if !strings.Contains(string(forwarded), servers[0].Headers[0].Value) {
		t.Fatal("daemon did not receive its private assignment")
	}
	mismatch = true
	if _, err := c.AssignMCP(context.Background(), b, servers); err == nil {
		t.Fatal("mismatched assignment receipt accepted")
	}
}
