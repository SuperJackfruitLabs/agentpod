package salaam

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// ConfigurationObservation is the non-secret part of what a running Salaam daemon reports about
// its own configuration in /v1/health (spec 2026-10-23, C7). It deliberately keeps no command
// lines, arguments, connection configuration or keys: MCP server arguments and provider
// connection settings can carry credentials, so only names, transports and digests leave here.
type ConfigurationObservation struct {
	// Readable is false when the daemon could not be asked or did not answer JSON.
	Readable bool
	Reason   string
	// ProviderRoute is {provider, model, endpoint}, or nil when the daemon reports none.
	ProviderRoute map[string]any
	// OperatorMCP is {digest, servers: [{name, transport, declarationDigest}]}, or nil.
	OperatorMCP map[string]any
	// PinsDigest is the digest of the AgentPod pins file the daemon is bound with.
	PinsDigest string
	// ToolsUser is the OS user tools run as, when this Salaam reports one (salaam #46).
	ToolsUser string
}

// ObserveConfiguration reads /v1/health and keeps only ConfigurationObservation's fields.
func (c *Client) ObserveConfiguration(ctx context.Context) ConfigurationObservation {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://salaam/v1/health", nil)
	if err != nil {
		return ConfigurationObservation{Reason: err.Error()}
	}
	res, err := c.httpClient().Do(req)
	if err != nil {
		return ConfigurationObservation{Reason: "operator socket unreachable"}
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return ConfigurationObservation{Reason: fmt.Sprintf("health answered HTTP %d", res.StatusCode)}
	}
	var out struct {
		ProviderRoute *struct {
			Provider   string `json:"provider"`
			Model      string `json:"model"`
			Connection *struct {
				Endpoint string `json:"endpoint"`
			} `json:"connection"`
		} `json:"provider_route"`
		OperatorMCP *struct {
			Digest  string `json:"digest"`
			Servers []struct {
				Name              string `json:"name"`
				Transport         string `json:"transport"`
				DeclarationDigest string `json:"declaration_digest"`
			} `json:"servers"`
		} `json:"operator_mcp"`
		PinsDigest string `json:"agentpod_pins_digest"`
		ToolsUser  string `json:"tools_user"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 1024*1024)).Decode(&out) != nil {
		return ConfigurationObservation{Reason: "health response is not JSON"}
	}
	obs := ConfigurationObservation{Readable: true, PinsDigest: out.PinsDigest, ToolsUser: out.ToolsUser}
	if r := out.ProviderRoute; r != nil {
		route := map[string]any{"provider": r.Provider, "model": r.Model}
		if r.Connection != nil && r.Connection.Endpoint != "" {
			route["endpoint"] = r.Connection.Endpoint
		}
		obs.ProviderRoute = route
	}
	if m := out.OperatorMCP; m != nil {
		servers := make([]any, 0, len(m.Servers))
		for _, s := range m.Servers {
			servers = append(servers, map[string]any{"name": s.Name, "transport": s.Transport, "declarationDigest": s.DeclarationDigest})
		}
		obs.OperatorMCP = map[string]any{"digest": m.Digest, "servers": servers}
	}
	return obs
}
