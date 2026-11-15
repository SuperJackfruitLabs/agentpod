// Package benchdispatch is a private node-side dispatch journal. It records
// observations and proposed settlement, never board authorization or acceptance.
// Its callbacks are trust seams for a future reviewed adapter, not certifiers.
package benchdispatch

import (
	"encoding/json"
	"regexp"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

const version = "agentpod.private-bench-dispatch.v1"
const maxState = 4 << 20
const maxRecords = 256

var (
	ErrInvalid  = benchattempt.ErrInvalid
	ErrPending  = benchattempt.ErrPending
	ErrOwner    = benchattempt.ErrOwner
	ErrConflict = benchattempt.ErrConflict
	ErrVerify   = benchattempt.ErrVerify
	idPattern   = regexp.MustCompile(benchattempt.IDPattern)
	hexPattern  = regexp.MustCompile(benchattempt.SHA256Pattern)
)

// Identity binds one attempt to its original owner. A reclaimed run is a NEW
// identity; it cannot reuse another run's observation or proposed settlement.
type Identity = benchattempt.Identity

// Source contains credential-free repository identity hashes, never repository
// URLs or arbitrary child-supplied links. The adapter must authorize this vector.
type Source = benchattempt.Source

// GroupedLaunch binds the protected worker's complete expected start vector.
// It contains no continuation token. Omission preserves scalar-v1 plan bytes.
type GroupedLaunch = benchattempt.GroupedLaunch

type Plan = benchattempt.Plan

// Observation is data, not a capability. Verify must independently bind these
// facts to trusted service receipts and the exact private worker result. A
// successful child, status read, or locally supplied boolean is insufficient.
type Observation = benchattempt.Observation

type Proposal = benchattempt.Proposal

type Record = benchattempt.Record

type state struct {
	Cancellations []benchattempt.Cancellation `json:"cancellations,omitempty"`
	Version       string                      `json:"version"`
	Source        *SourceReservation          `json:"source,omitempty"`
	BenchKey      string                      `json:"bench_key"`
	Active        string                      `json:"active,omitempty"`
	Records       []Record                    `json:"records"`
}

var digest = benchattempt.RawSHA256
var planID = benchattempt.PlanIdentitySHA256
var planDigest = benchattempt.PlanSHA256

func samePlan(a, b Plan) bool { return planDigest(a) == planDigest(b) }

func validatePlan(p Plan) error {
	ids := []string{p.Identity.TenantID, p.Identity.BoardID, p.Identity.CardID, p.Identity.StageID, p.Identity.RunID, p.Identity.AgentID, p.Identity.StationID, p.Identity.NodeID, p.Identity.AttemptID, p.Identity.ControlPrincipalID, p.Identity.ControlGrantID, p.HostID, p.RegistrationID}
	for _, s := range ids {
		if !idPattern.MatchString(s) {
			return ErrInvalid
		}
	}
	if p.Identity.Epoch == 0 {
		return ErrInvalid
	}
	for _, h := range []string{p.Identity.PolicySHA256, p.RequestSHA256, p.BodySHA256, p.ContextSHA256, p.ExecutableSHA256} {
		if !hexPattern.MatchString(h) {
			return ErrInvalid
		}
	}
	if !validSources(p.Sources) || !physicalName(p.ContextPath) || !physicalName(p.ExecutablePath) || len(p.ContextPath) > 4096 || len(p.ExecutablePath) > 4096 {
		return ErrInvalid
	}
	if p.Grouped != nil {
		return validateGroupedPlan(p)
	}
	// Validate the producer's own scalar request identity rules without inventing
	// a held-token run extension. Actual raw arguments are bound at Dispatch.
	raw, _ := json.Marshal(superbench.Request{Version: superbench.Version, Operation: "run", Key: p.BenchKey, Holder: p.Holder, RequestID: p.RequestID, Arguments: []string{p.ExecutablePath, p.ContextPath}})
	_, err := superbench.Parse(raw)
	if err != nil {
		return ErrInvalid
	}
	return nil
}

var validSources = benchattempt.ValidSources
var validRef = benchattempt.ValidRef
var validateObservation = benchattempt.ValidateObservation
