package forgeapi

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi/stkpolicy"
)

func baseEntry() stkpolicy.PolicyEntry {
	return stkpolicy.PolicyEntry{
		Service: "forge-forgejo-aaa111", Provider: "forgejo", Instance: "https://forge.example.com",
		Mode: "minted", Repositories: []string{"acme/widgets"}, Preset: "read",
		Station: "stn_1", Grant: "fag_aaa111",
	}
}
