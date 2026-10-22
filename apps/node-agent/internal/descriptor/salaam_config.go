package descriptor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
	"io"
)

const salaamHostManifestSetting = "salaam.host.manifest"

// Report-only settings (spec 2026-10-23, C7): what the running daemon says about its own
// configuration, read from /v1/health. The node never writes them, and none carries a secret:
// no MCP command lines or arguments, no provider connection settings, no keys.
const (
	salaamProviderRouteSetting = "salaam.provider.route"
	salaamOperatorMCPSetting   = "salaam.mcp.operator"
	salaamPinsDigestSetting    = "salaam.agentpod.pins"
	salaamToolsUserSetting     = "salaam.tools.user"
)

var salaamReportOnly = []string{salaamProviderRouteSetting, salaamOperatorMCPSetting, salaamPinsDigestSetting, salaamToolsUserSetting}

func (s *salaamDescriptor) manifestManaged() bool {
	return s.config.Manifest != "" && s.config.NodeBinary != ""
}

func (s *salaamDescriptor) ConfigSettings() []ConfigSetting {
	if !s.configured() {
		return nil
	}
	var out []ConfigSetting
	for _, id := range salaamReportOnly {
		out = append(out, ConfigSetting{ID: id, Harness: "salaam", Scope: "profile", Policy: "report-only", RestartToTakeEffect: false})
	}
	if s.manifestManaged() {
		out = append(out, ConfigSetting{ID: salaamHostManifestSetting, Harness: "salaam", Scope: "profile", Policy: "reconcilable", RestartToTakeEffect: true})
	}
	return out
}
func (s *salaamDescriptor) configuration(ctx context.Context, key, action string, request any, out any) error {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() || !s.manifestManaged() {
		return fmt.Errorf("salaam: configuration requires the enrolled station and reviewed private runtime")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var data []byte
	var err error
	if s.configure != nil {
		data, err = s.configure(ctx, action, request)
	} else {
		data, err = s.client().Runtime.Configuration(ctx, action, request)
	}
	if err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("salaam: invalid native configuration response")
	}
	return nil
}
func (s *salaamDescriptor) ObserveConfig(ctx context.Context, key string, settings []string) ([]ConfigValue, error) {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() {
		return nil, fmt.Errorf("salaam: configuration requires the enrolled station")
	}
	var manifest, reported []string
	for _, id := range settings {
		switch {
		case id == salaamHostManifestSetting:
			manifest = append(manifest, id)
		case isSalaamReportOnly(id):
			reported = append(reported, id)
		default:
			return nil, fmt.Errorf("salaam: unknown managed setting")
		}
	}
	var values []ConfigValue
	if len(reported) > 0 {
		values = append(values, salaamReportedValues(s.client().ObserveConfiguration(ctx), reported)...)
	}
	if len(manifest) > 0 {
		var result struct {
			Values []ConfigValue `json:"values"`
		}
		if err := s.configuration(ctx, key, "observe", map[string]any{"stationKey": key, "settings": manifest}, &result); err != nil {
			return nil, err
		}
		values = append(values, result.Values...)
	}
	return values, nil
}

func isSalaamReportOnly(id string) bool {
	for _, r := range salaamReportOnly {
		if r == id {
			return true
		}
	}
	return false
}

// salaamReportedValues turns one health observation into the requested report-only values. An
// unreadable daemon makes every value unreadable, never absent; a field this Salaam does not
// report is readable and absent (an older Salaam has no tools_user, for one).
func salaamReportedValues(obs salaam.ConfigurationObservation, ids []string) []ConfigValue {
	out := make([]ConfigValue, 0, len(ids))
	for _, id := range ids {
		v := ConfigValue{SettingID: id}
		if !obs.Readable {
			v.Reason = obs.Reason
			out = append(out, v)
			continue
		}
		var observed any
		switch id {
		case salaamProviderRouteSetting:
			if obs.ProviderRoute != nil {
				observed = obs.ProviderRoute
			}
		case salaamOperatorMCPSetting:
			if obs.OperatorMCP != nil {
				observed = obs.OperatorMCP
			}
		case salaamPinsDigestSetting:
			if obs.PinsDigest != "" {
				observed = obs.PinsDigest
			}
		case salaamToolsUserSetting:
			if obs.ToolsUser != "" {
				observed = obs.ToolsUser
			}
		}
		v.Readable = true
		if observed != nil {
			v.Observed = observed
		}
		out = append(out, v)
	}
	return out
}
func (s *salaamDescriptor) PlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (ConfigPlan, error) {
	var result ConfigPlan
	err := s.configuration(ctx, key, "plan", map[string]any{"stationKey": key, "operationId": operationID, "want": want}, &result)
	if err == nil && (result.StationKey != key || result.OperationID != operationID || result.SchemaVersion != 1) {
		err = fmt.Errorf("salaam: native plan belongs to another operation")
	}
	return result, err
}
func (s *salaamDescriptor) ApplyConfig(ctx context.Context, key, operationID, planDigest string) (ConfigReceipt, error) {
	return s.configReceipt(ctx, key, operationID, "apply", map[string]any{"stationKey": key, "operationId": operationID, "planDigest": planDigest})
}
func (s *salaamDescriptor) InspectConfig(ctx context.Context, key, operationID string) (ConfigReceipt, error) {
	return s.configReceipt(ctx, key, operationID, "inspect", map[string]any{"stationKey": key, "operationId": operationID})
}
func (s *salaamDescriptor) configReceipt(ctx context.Context, key, operationID, action string, request any) (ConfigReceipt, error) {
	var result ConfigReceipt
	err := s.configuration(ctx, key, action, request, &result)
	if err == nil && (result.Plan.StationKey != key || result.Plan.OperationID != operationID) {
		err = fmt.Errorf("salaam: native receipt belongs to another operation")
	}
	return result, err
}
