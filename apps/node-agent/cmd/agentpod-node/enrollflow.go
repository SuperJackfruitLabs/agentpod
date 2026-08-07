package main

import (
	"fmt"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

// enrollDecision is the outcome of the self-healing enroll flow (#161).
type enrollDecision int

const (
	decisionKeep           enrollDecision = iota // valid config on this hub — idempotent no-op
	decisionEnroll                               // enroll with the provided token
	decisionKeepUnverified                       // hub unreachable — keep config, warn, exit 0
)

// decideEnroll implements the spec's decision flow: force > hub-mismatch >
// credential-check. checkCred is injected for tests (enroll.CheckCredential
// in production). Never destroys a stored identity it could not verify.
func decideEnroll(cfg config.Config, haveConfig bool, hub string, force bool,
	checkCred func(hub, id, secret string) (bool, error)) (enrollDecision, string) {
	if !haveConfig {
		return decisionEnroll, "no existing config"
	}
	if force {
		return decisionEnroll, "--force"
	}
	if cfg.Hub != hub {
		return decisionEnroll, fmt.Sprintf("hub changed (%s → %s)", cfg.Hub, hub)
	}
	valid, err := checkCred(hub, cfg.NodeID, cfg.NodeSecret)
	if err != nil {
		return decisionKeepUnverified, "hub unreachable: " + err.Error()
	}
	if valid {
		return decisionKeep, "credential verified"
	}
	return decisionEnroll, "stored credential rejected by hub"
}
