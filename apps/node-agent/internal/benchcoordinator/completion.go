// Package benchcoordinator owns private, credential-free coordinator projections.
// It does not register a broker verb or provide admission/reporting authority.
package benchcoordinator

import (
	"context"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcanonical"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// Completion contains independently reparsed historical service observations and
// bounded, UNTRUSTED task output. It is neither board acceptance nor attestation.
// No private launch plan, credential, filesystem path, or repository URL is added.
type Completion struct {
	Source              benchdispatch.SourceBinding `json:"source"`
	Service             benchdispatch.Observation   `json:"service"`
	Task                superbench.WorkerResult     `json:"task"`
	SourceRequestSHA256 string                      `json:"source_request_sha256"`
	SourceReceiptSHA256 string                      `json:"source_receipt_sha256"`
}

// ReadCompletion never dispatches or grants ownership. A future authenticated
// broker adapter must independently authorize disclosure and current admission.
func ReadCompletion(ctx context.Context, store benchdispatch.Store, spec benchdispatch.SourceSpec) (Completion, error) {
	var c Completion
	var d benchcanonical.Digests
	var err error
	c.Source, c.Service, c.Task, d, err = store.CompletedCanonical(ctx, spec)
	if err != nil {
		return Completion{}, err
	}
	c.SourceRequestSHA256 = d.SourceRequestSHA256
	c.SourceReceiptSHA256 = d.SourceReceiptSHA256
	return c, nil
}
