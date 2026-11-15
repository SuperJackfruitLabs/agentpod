// Package benchdispatch is a private node-side dispatch journal. It records
// observations and proposed settlement, never board authorization or acceptance.
// Its callbacks are trust seams for a future reviewed adapter, not certifiers.
package benchdispatch

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
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

var validatePlan = benchattempt.ValidatePlan

var validateObservation = benchattempt.ValidateObservation
