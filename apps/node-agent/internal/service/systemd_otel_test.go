package service

import (
	"strings"
	"testing"
)

func TestUnitsReadAnOptionalTelemetryEnvFile(t *testing.T) {
	if !strings.Contains(systemdSystemUnitTemplate, "EnvironmentFile=-/etc/agentpod-node/otel.env") {
		t.Error("system unit: missing optional EnvironmentFile for telemetry")
	}
	if !strings.Contains(systemdUserUnitTemplate, "EnvironmentFile=-%h/.config/agentpod-node/otel.env") {
		t.Error("user unit: missing optional EnvironmentFile for telemetry")
	}
}
