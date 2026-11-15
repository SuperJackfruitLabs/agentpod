package benchdispatch

import "github.com/rakeshgangwar/agentpod/node-agent/internal/benchjournal"

var (
	physicalName = benchjournal.PhysicalName
	physicalDir  = benchjournal.PhysicalDir
	readFile     = benchjournal.ReadFile
	syncDir      = benchjournal.SyncDir
	writeAtomic  = benchjournal.WriteAtomic
	decode       = benchjournal.Decode
	unique       = benchjournal.Unique
)
