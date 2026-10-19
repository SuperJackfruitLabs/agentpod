package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Config struct {
	Hub        string `json:"hub"`
	NodeID     string `json:"nodeId"`
	NodeSecret string `json:"nodeSecret"`
	// HermesStartCmd is the shell command used to start the Hermes gateway.
	// Needed by the lifecycle "start" and "restart" actions. Optional.
	HermesStartCmd string `json:"hermesStartCmd,omitempty"`
	// OpenClawStartCmd is the shell command used to start the OpenClaw gateway.
	// Needed by the lifecycle "start" and "restart" actions. Optional.
	OpenClawStartCmd string `json:"openclawStartCmd,omitempty"`
	// OpenClawGatewayURL / OpenClawTokenFile / OpenClawSessionLabel configure the
	// `openclaw acp` bridge. All optional: with a local Gateway, openclaw resolves
	// its own URL from config. The token is passed as a FILE PATH, never inline —
	// argv is world-readable.
	// OpenClawBinary is the openclaw executable to spawn (absolute path). Optional:
	// when empty the node-agent resolves it from PATH, then from well-known install
	// paths. Set it when openclaw lives somewhere the service's PATH can't see —
	// e.g. a pnpm global install under ~/.local/share/pnpm, invisible to a systemd
	// user service.
	OpenClawBinary       string `json:"openclawBinary,omitempty"`
	OpenClawGatewayURL   string `json:"openclawGatewayUrl,omitempty"`
	OpenClawTokenFile    string `json:"openclawTokenFile,omitempty"`
	OpenClawSessionLabel string `json:"openclawSessionLabel,omitempty"`
	// Claude Code has no native ACP mode: sessions run through the external
	// claude-agent-acp adapter (a Node program). All three keys are optional —
	// with the adapter or npx on PATH, a node needs no configuration.
	//
	// ClaudeCodeAcpBinary is a claude-agent-acp executable, used verbatim as
	// argv[0]; when empty the node-agent resolves it from PATH, then from
	// well-known install paths, then falls back to a version-pinned `npx -y`.
	// ClaudeCodeBinary is the claude CLI exported as CLAUDE_CODE_EXECUTABLE, so
	// the ACP session drives the same install the Health tab reports on.
	// NodeBinary is the node runtime (its directory also supplies npx) for hosts
	// where node isn't on the service's PATH.
	ClaudeCodeAcpBinary string `json:"claudeCodeAcpBinary,omitempty"`
	ClaudeCodeBinary    string `json:"claudeCodeBinary,omitempty"`
	// Codex has no native ACP mode either: sessions run through the external
	// codex-acp adapter (also a Node program, so it shares NodeBinary above).
	//
	// CodexAcpBinary is a codex-acp executable, used verbatim as argv[0]; when
	// empty the node-agent resolves it from PATH, then from well-known install
	// paths, then falls back to a version-pinned `npx -y`.
	// CodexBinary is an OPT-IN codex CLI exported as CODEX_PATH. Leave it empty
	// unless the node's codex is new enough to expose `app-server` (the interface
	// codex-acp drives): empty means the adapter uses its own bundled, known-
	// compatible Codex, and an older CLI dies with "Device not configured
	// (os error 6)". It is never auto-discovered for exactly that reason.
	//
	// There is deliberately NO key for CODEX_API_KEY/OPENAI_API_KEY: a key in this
	// file would end up in argv or in a child's environment, i.e. readable via
	// `ps`. Codex key auth belongs in the node-agent SERVICE's environment, which
	// the adapter inherits.
	CodexAcpBinary string `json:"codexAcpBinary,omitempty"`
	CodexBinary    string `json:"codexBinary,omitempty"`

	// MuseAcpBinary is a muse-acp executable, when it is not on the service's
	// PATH. MuseBinary pins which muse CLI the adapter drives (exported to it
	// as MUSE_CLI); empty means "resolve it", never "ignore it".
	MuseAcpBinary string `json:"museAcpBinary,omitempty"`
	MuseBinary    string `json:"museBinary,omitempty"`

	// KiloDataDir overrides where Kilo keeps its data (default
	// $XDG_DATA_HOME/kilo, else ~/.local/share/kilo); KiloBinary pins which
	// kilo CLI serves ACP. Both empty means "resolve it".
	KiloDataDir string `json:"kiloDataDir,omitempty"`
	KiloBinary  string `json:"kiloBinary,omitempty"`
	NodeBinary  string `json:"nodeBinary,omitempty"`
	// Salaam is opt-in and uses a separately running, pinned daemon. No station writes are advertised.
	SalaamBinary    string `json:"salaamBinary,omitempty"`
	SalaamStateDir  string `json:"salaamStateDir,omitempty"`
	SalaamWorkspace string `json:"salaamWorkspace,omitempty"`
	// Explicit private Node and reviewed host manifest opt into deterministic daemon startup.
	SalaamNodeBinary string `json:"salaamNodeBinary,omitempty"`
	SalaamManifest   string `json:"salaamManifest,omitempty"`
	// NativeSkillActivation is an explicit operator opt-in for the separate
	// native-placement transaction. It is off by default.
	NativeSkillActivation bool `json:"nativeSkillActivation,omitempty"`
	// PluginManagement lets the Console install and remove the agentpod-live
	// Hermes plugin through reviewed plans. It is off by default.
	PluginManagement bool `json:"pluginManagement,omitempty"`
	// ConfigManagement lets the Console read a registered subset of a
	// descriptor's own harness configuration (config.manage). It is off by
	// default.
	ConfigManagement bool `json:"configManagement,omitempty"`
	// StationTokens names the stations whose hub token this node keeps fresh on disk, so an
	// agent can reach a work plane as ITSELF without ever holding the node's credential.
	// Empty by default: a token that reaches another plane is not something every station
	// should silently acquire, and the node cannot discover its own station ids anyway
	// (`GET /api/nodes/:nodeId/stations` authenticates a human, not a node credential).
	// See internal/stationtoken.
	StationTokens []StationToken `json:"stationTokens,omitempty"`
	// MCPProxy runs the node's loopback MCP proxy for the stations it names, so their harness
	// sessions reach the hub's MCP server and Superlibrary's as the station's own agent, for as
	// long as the session runs — with no credential leaving the node. Absent or no stations: off.
	// Named per station for the reason StationTokens is. See internal/mcpproxy.
	MCPProxy *MCPProxy `json:"mcpProxy,omitempty"`
	// ForgeAPI tunes forge API access: each station gets its own stk instance (own OS user,
	// state, policy file, proxy port and key, systemd unit). Absent: the defaults below. The
	// environment variables AGENTPOD_STK_SHARED_POLICY, AGENTPOD_STK_PORTS ("8900-8999") and
	// AGENTPOD_STK_REGISTRY override these.
	ForgeAPI *ForgeAPI `json:"forgeApi,omitempty"`
}

// ForgeAPI configures the per-station stk instances. Zero values mean the defaults.
type ForgeAPI struct {
	// SharedPolicy is an operator-authored stk policy file of services every station needs; its
	// entries are copied into each station's own policy (default /etc/agentpod/stk-shared.yaml;
	// absent file: none).
	SharedPolicy string `json:"sharedPolicy,omitempty"`
	// ProxyPortMin and ProxyPortMax bound the proxy ports handed to station instances
	// (default 8900-8999).
	ProxyPortMin int `json:"proxyPortMin,omitempty"`
	ProxyPortMax int `json:"proxyPortMax,omitempty"`
	// Registry is the node-owned file that remembers which instance and port belong to which
	// station (default /var/lib/agentpod/forge-api/stk-instances.json, mode 0600).
	Registry string `json:"registry,omitempty"`
	// StationUIDs maps a station id to the uid(s) its agents run as. Per-station isolation only
	// holds when every station's agents have a distinct uid; a station missing here is taken to run
	// as the node's own uid. The node does not switch uids itself: this states how harnesses are
	// started, and a second station whose uids overlap another's is refused (`station-uid-shared`).
	StationUIDs map[string][]int `json:"stationUids,omitempty"`
	// AllowSharedAgentUID is the operator's acknowledgement that stations sharing an agent uid are
	// NOT isolated from each other (they can read each other's environment and use each other's
	// proxy key). Default false: such a station is refused. Env: AGENTPOD_ALLOW_SHARED_AGENT_UID=1.
	AllowSharedAgentUID bool `json:"allowSharedAgentUid,omitempty"`
}

// MCPProxy configures the loopback MCP proxy.
type MCPProxy struct {
	// Stations are the hub station ids the proxy serves.
	Stations []string `json:"stations"`
	// SuperlibraryURL is Superlibrary's MCP endpoint; empty means mcpproxy.DefaultSuperlibraryURL.
	SuperlibraryURL string `json:"superlibraryUrl,omitempty"`
}

// StationToken is one station whose token is kept at a path.
type StationToken struct {
	StationID string `json:"stationId"`
	Path      string `json:"path"`
}

func DefaultPath() string {
	d, _ := os.UserConfigDir()
	return filepath.Join(d, "agentpod-node", "config.json")
}

func Save(path string, c Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func Load(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	return c, json.Unmarshal(b, &c)
}

// SetMCPProxyStations sets `mcpProxy.stations` in the config at path and leaves every other key
// exactly as it was — including keys this binary does not model, which a Load/Save round trip
// would silently drop. The write is atomic (a 0600 temporary renamed over the file), so a crash
// cannot leave a node with half a config and no credential.
func SetMCPProxyStations(path string, stations []string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	section := map[string]json.RawMessage{}
	if prev, ok := raw["mcpProxy"]; ok && string(prev) != "null" {
		if err := json.Unmarshal(prev, &section); err != nil {
			return err
		}
	}
	if stations == nil {
		stations = []string{}
	}
	if section["stations"], err = json.Marshal(stations); err != nil {
		return err
	}
	if raw["mcpProxy"], err = json.Marshal(section); err != nil {
		return err
	}
	out, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(path, out)
}

func writeAtomic(path string, b []byte) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
