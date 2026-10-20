package salaam

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/mcpproxy"
)

// MCPAssignment is private node→daemon control. Proxy headers never enter ACP input or env.
// Canonical ownership and conformance corpus: packages/contract/src/salaam-mcp.ts.
type MCPAssignment struct {
	Version              int               `json:"version"`
	Binding              Binding           `json:"binding"`
	ProfileDigest        string            `json:"profile_digest"`
	CredentialGeneration int64             `json:"credential_generation"`
	Servers              []mcpproxy.Server `json:"servers"`
}
type MCPBinder func(string, mcpproxy.Identity) ([]mcpproxy.Server, error)

func (a *MCPAssignment) UnmarshalJSON(data []byte) error {
	type plain MCPAssignment
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode((*plain)(a))
}

var mcpHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var mcpID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func (a MCPAssignment) Validate() error {
	fail := func() error { return fmt.Errorf("salaam: invalid private managed MCP assignment") }
	b := a.Binding
	if a.Version != 1 || !mcpHash.MatchString(a.ProfileDigest) || a.CredentialGeneration < 1 || a.CredentialGeneration > 9007199254740991 || len(a.Servers) < 1 || len(a.Servers) > 2 {
		return fail()
	}
	if b.Version != 1 || !regexp.MustCompile(`^org_[a-f0-9]{20}$`).MatchString(b.OrganizationID) || !regexp.MustCompile(`^prn_[a-f0-9]{20}$`).MatchString(b.PrincipalID) || !regexp.MustCompile(`^salaam:[a-f0-9]{16}$`).MatchString(b.StationKey) ||
		!mcpID.MatchString(b.NodeID) || !mcpID.MatchString(b.StationID) || !mcpID.MatchString(b.HubSessionID) || !mcpID.MatchString(b.Run.ID) || b.OccupancyEpoch < 1 || b.OccupancyEpoch > 9007199254740991 || b.Run.Epoch < 1 || b.Run.Epoch > 9007199254740991 ||
		(b.Run.Source != "agentpod" && b.Run.Source != "superpipeline") || len(b.Workspace) > 4096 || !strings.HasPrefix(b.Workspace, "/") || strings.ContainsRune(b.Workspace, 0) {
		return fail()
	}
	names := map[string]bool{}
	origin, key := "", ""
	for _, s := range a.Servers {
		if s.Type != "http" || (s.Name != "agentpod" && s.Name != "superlibrary") || names[s.Name] || len(s.URL) > 1024 || len(s.Headers) != 1 || s.Headers[0].Name != mcpproxy.SecretHeader || !regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`).MatchString(s.Headers[0].Value) {
			return fail()
		}
		names[s.Name] = true
		u, err := url.Parse(s.URL)
		if err != nil {
			return fail()
		}
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return fail()
		}
		segment := s.Name
		if segment == "agentpod" {
			segment = "hub"
		}
		parts := strings.Split(u.EscapedPath(), "/")
		if len(parts) != 6 || parts[1] != "stations" || parts[3] != "mcp-managed-v1" || !mcpHash.MatchString(parts[4]) || parts[5] != segment {
			return fail()
		}
		station, err := url.PathUnescape(parts[2])
		if err != nil || station != b.StationID {
			return fail()
		}
		host := "127.0.0.1:" + strconv.Itoa(port)
		if u.Hostname() == "::1" {
			host = "[::1]:" + strconv.Itoa(port)
		}
		if u.Scheme != "http" || port == 80 || u.Host != host || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.String() != s.URL || s.URL != "http://"+u.Host+u.EscapedPath() {
			return fail()
		}
		current := u.Scheme + "://" + u.Host
		if origin != "" && (origin != current || key != s.Headers[0].Value) {
			return fail()
		}
		origin, key = current, s.Headers[0].Value
	}
	return nil
}

type MCPToolPin struct {
	Name         string `json:"name"`
	SchemaDigest string `json:"schema_digest"`
	Policy       string `json:"policy"`
}
type MCPServerView struct {
	Name           string       `json:"name"`
	EndpointDigest string       `json:"endpoint_digest"`
	CatalogDigest  string       `json:"catalog_digest"`
	Tools          []MCPToolPin `json:"tools"`
}
type MCPView struct {
	Version              int             `json:"version"`
	ProfileDigest        string          `json:"profile_digest"`
	AssignmentDigest     string          `json:"assignment_digest"`
	BindingDigest        string          `json:"binding_digest"`
	CredentialGeneration int64           `json:"credential_generation"`
	Servers              []MCPServerView `json:"servers"`
}

func (v *MCPView) UnmarshalJSON(data []byte) error {
	type plain MCPView
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode((*plain)(v))
}
func (v MCPView) Validate() error {
	fail := func() error { return fmt.Errorf("salaam: invalid managed MCP readiness receipt") }
	if v.Version != 1 || !mcpHash.MatchString(v.ProfileDigest) || !mcpHash.MatchString(v.AssignmentDigest) || !mcpHash.MatchString(v.BindingDigest) || v.CredentialGeneration < 1 || v.CredentialGeneration > 9007199254740991 || len(v.Servers) < 1 || len(v.Servers) > 2 {
		return fail()
	}
	seen := map[string]bool{}
	for _, s := range v.Servers {
		if (s.Name != "agentpod" && s.Name != "superlibrary") || seen[s.Name] || !mcpHash.MatchString(s.EndpointDigest) || !mcpHash.MatchString(s.CatalogDigest) || len(s.Tools) < 1 || len(s.Tools) > 128 {
			return fail()
		}
		seen[s.Name] = true
		tools := map[string]bool{}
		for _, t := range s.Tools {
			if !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`).MatchString(t.Name) || tools[t.Name] || !mcpHash.MatchString(t.SchemaDigest) || (t.Policy != "read" && t.Policy != "approval") {
				return fail()
			}
			tools[t.Name] = true
		}
	}
	return nil
}

func canonicalDigest(value any) string {
	// Convert structs to maps so key ordering matches the wire's canonical object order.
	b, _ := json.Marshal(value)
	var object any
	_ = json.Unmarshal(b, &object)
	var out bytes.Buffer
	e := json.NewEncoder(&out)
	e.SetEscapeHTML(false)
	_ = e.Encode(object)
	encoded := bytes.TrimSuffix(out.Bytes(), []byte("\n"))
	var wire bytes.Buffer
	// Contract field names are ASCII. JSON.stringify emits actual U+2028/U+2029 in string
	// values; Go escapes them even with EscapeHTML(false). Preserve escaped literal backslashes.
	for i := 0; i < len(encoded); {
		if encoded[i] == '\\' && i+1 < len(encoded) {
			if bytes.HasPrefix(encoded[i:], []byte(`\u2028`)) {
				wire.WriteRune('\u2028')
				i += 6
				continue
			}
			if bytes.HasPrefix(encoded[i:], []byte(`\u2029`)) {
				wire.WriteRune('\u2029')
				i += 6
				continue
			}
			wire.Write(encoded[i : i+2])
			i += 2
			continue
		}
		wire.WriteByte(encoded[i])
		i++
	}
	h := sha256.Sum256(wire.Bytes())
	return hex.EncodeToString(h[:])
}

// AssignMCP returns credential-free declarations only after a matching daemon receipt.
// The proxy owns the credential generation; neither Hub input nor wall clock supplies it.
func (c *Client) AssignMCP(ctx context.Context, b Binding, servers []mcpproxy.Server) ([]mcpproxy.Server, error) {
	if err := c.validate(b); err != nil {
		return nil, err
	}
	if len(servers) < 1 {
		return nil, fmt.Errorf("salaam: no station proxy assignment")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "http://salaam/v1/health", nil)
	if err != nil {
		return nil, err
	}
	res, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("salaam: MCP profile health unavailable")
	}
	var health struct {
		Service    string `json:"service"`
		ManagedMCP *struct {
			ProfileDigest string `json:"profile_digest"`
		} `json:"managed_mcp"`
	}
	err = json.NewDecoder(io.LimitReader(res.Body, 1024*1024)).Decode(&health)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || health.Service != "healthy" || health.ManagedMCP == nil || !mcpHash.MatchString(health.ManagedMCP.ProfileDigest) {
		return nil, fmt.Errorf("salaam: reviewed managed MCP host profile is unavailable")
	}
	status, err := c.Request(ctx, "status", b, "", 0, "")
	if err != nil || !status.Authorized || status.Revoked {
		return nil, fmt.Errorf("salaam: fresh root authority is required for managed MCP binding")
	}
	if c.BindMCP == nil {
		return nil, fmt.Errorf("salaam: managed MCP requires an identity-bound node proxy")
	}
	servers, err = c.BindMCP(b.StationID, mcpproxy.Identity{BindingDigest: canonicalDigest(b), OrganizationID: b.OrganizationID, PrincipalID: b.PrincipalID, OccupancyEpoch: b.OccupancyEpoch})
	if err != nil || len(servers) < 1 {
		return nil, fmt.Errorf("salaam: managed proxy identity admission failed")
	}
	generation := servers[0].CredentialGeneration
	for _, s := range servers {
		if s.CredentialGeneration != generation {
			return nil, fmt.Errorf("salaam: inconsistent proxy credential generation")
		}
	}
	assignment := MCPAssignment{Version: 1, Binding: b, ProfileDigest: health.ManagedMCP.ProfileDigest, CredentialGeneration: generation, Servers: servers}
	if err := assignment.Validate(); err != nil {
		return nil, err
	}
	for _, server := range servers {
		u, _ := url.Parse(server.URL)
		if strings.Split(u.EscapedPath(), "/")[4] != canonicalDigest(b) {
			return nil, fmt.Errorf("salaam: managed endpoint belongs to another root binding")
		}
	}
	var view MCPView
	if err := c.call(ctx, "mcp-assign", map[string]any{"binding": b, "assignment": assignment}, &view); err != nil {
		return nil, err
	}
	if err := view.Validate(); err != nil {
		return nil, err
	}
	if view.Version != 1 || view.ProfileDigest != assignment.ProfileDigest || view.AssignmentDigest != canonicalDigest(assignment) || view.BindingDigest != canonicalDigest(b) || view.CredentialGeneration != generation || len(view.Servers) != len(servers) {
		return nil, fmt.Errorf("salaam: MCP receipt differs from private assignment")
	}
	public := make([]mcpproxy.Server, 0, len(servers))
	seen := map[string]bool{}
	for _, server := range servers {
		found := false
		for _, s := range view.Servers {
			if s.Name == server.Name && !seen[s.Name] && s.EndpointDigest == canonicalDigest(server.URL) && mcpHash.MatchString(s.CatalogDigest) && len(s.Tools) > 0 && len(s.Tools) <= 128 {
				toolNames := map[string]bool{}
				for _, t := range s.Tools {
					if t.Name == "" || toolNames[t.Name] || !mcpHash.MatchString(t.SchemaDigest) || (t.Policy != "read" && t.Policy != "approval") {
						return nil, fmt.Errorf("salaam: malformed MCP tool admission receipt")
					}
					toolNames[t.Name] = true
				}
				seen[s.Name] = true
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("salaam: MCP server receipt does not bind assigned endpoint")
		}
		public = append(public, mcpproxy.Server{Type: server.Type, Name: server.Name, URL: server.URL, Headers: []mcpproxy.Header{}})
	}
	return public, nil
}
