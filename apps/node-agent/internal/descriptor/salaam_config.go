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

func (s *salaamDescriptor) ConfigSettings() []ConfigSetting {
	if s.config.Manifest == "" || s.config.NodeBinary == "" {
		return nil
	}
	return []ConfigSetting{{ID: salaamHostManifestSetting, Harness: "salaam", Scope: "profile", Policy: "reconcilable", RestartToTakeEffect: true}}
}
func (s *salaamDescriptor) configuration(ctx context.Context, key, action string, request any, out any) error {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() || len(s.ConfigSettings()) == 0 {
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
	for _, id := range settings {
		if id != salaamHostManifestSetting {
			return nil, fmt.Errorf("salaam: unknown managed setting")
		}
	}
	var result struct {
		Values []ConfigValue `json:"values"`
	}
	err := s.configuration(ctx, key, "observe", map[string]any{"stationKey": key, "settings": settings}, &result)
	return result.Values, err
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
