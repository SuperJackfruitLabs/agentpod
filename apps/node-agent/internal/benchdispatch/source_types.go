package benchdispatch

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchsource"
)

const sourceVersion = "agentpod.private-bench-dispatch.v2"

// SourceSpec reserves a fixed task/host/packaging identity before any source
// growth. It has no repository URLs, arguments, environment or capabilities.
type SourceSpec = benchattempt.SourceSpec

type SourceRepository = benchattempt.SourceRepository

type SourceOperation = benchattempt.SourceOperation

type SourceReservation = benchattempt.SourceReservation

var sourceID = benchattempt.SourceIdentitySHA256
var sourceDigest = benchattempt.SourceSpecSHA256

var validSourceSpec = benchsource.ValidSpec
var validReservation = benchsource.ValidReservation
var sourcePlanMatches = benchsource.PlanMatches
var sourceRequestMatches = benchsource.RequestMatches
var sourceSteps = benchattempt.SourceSteps
