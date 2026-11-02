package forgeapi

import (
	"sort"
	"strings"
)

const sharedUIDMessage = "stations on this node share an agent uid, so per-station isolation cannot hold; give each station's agents their own uid through the node's per-station uid mapping (forgeApi.stationUids), or acknowledge the risk with allowSharedAgentUid"

// ---- where a station's agents really run ----

// isolationInfo is the part of the isolation verdict that comes from uids: Shared when the
// station's agents share a uid with another registered station, NodeUID when they run as the uid
// the node itself runs as.
type isolationInfo struct{ Shared, NodeUID bool }

// effectiveUIDs are the uids the station's agent paths REALLY run as: every path its harness has
// ("spawn" always; a long-lived "gateway" for Hermes and OpenClaw), each asked of HarnessRunsAs,
// with an unknown path counting as the node's own uid. A station whose key the node does not yet
// know has the spawn path only. forgeApi.stationUids is not consulted: the node starts ACP
// sessions and terminals with plain exec, so they run as the node whatever the operator mapped.
func (m *StationInstances) effectiveUIDs(station, key string) []int {
	paths := []string{"spawn"}
	if strings.TrimSpace(key) != "" {
		paths = HarnessPaths(harnessOf(key))
	}
	var out []int
	seen := map[int]bool{}
	for _, p := range paths {
		uid, known := 0, false
		if m.cfg.HarnessRunsAs != nil {
			uid, known = m.cfg.HarnessRunsAs(station, p)
		}
		if !known {
			uid = m.env.euid
		}
		if !seen[uid] {
			seen[uid] = true
			out = append(out, uid)
		}
	}
	sort.Ints(out)
	return out
}

func (m *StationInstances) isolationOf(recs map[string]record, station string, uids []int) isolationInfo {
	info := isolationInfo{Shared: sharesUID(recs, station, uids)}
	for _, u := range uids {
		if u == m.env.euid {
			info.NodeUID = true
		}
	}
	return info
}

const nodeUIDMessage = "this station's agents run as the uid the node itself runs as (the node starts agent sessions and terminals without switching users), so the broker's separate user protects nothing from them"

// joinReasons joins the distinct non-empty reasons: a degraded verdict tells every cause.
func joinReasons(rs ...string) string {
	var out []string
	seen := map[string]bool{}
	for _, r := range rs {
		if r = strings.TrimSpace(r); r != "" && !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return strings.Join(out, "; ")
}

// degrade applies the uid part of the verdict to an ack's isolation fields. reason may be nil.
func (i isolationInfo) degrade(isolation, detail, reason *string) {
	switch {
	case i.Shared:
		*isolation, *detail = "same-user", IsolationSharedUID
		if reason != nil {
			*reason = joinReasons(*reason, nodeUIDIf(i), sharedUIDMessage)
		}
	case i.NodeUID:
		*isolation, *detail = "same-user", IsolationNodeUID
		if reason != nil {
			*reason = joinReasons(*reason, nodeUIDMessage)
		}
	}
}

func nodeUIDIf(i isolationInfo) string {
	if i.NodeUID {
		return nodeUIDMessage
	}
	return ""
}

// IsolationSharedUID is the detail an acknowledged shared-uid station reports beside the contract's
// `same-user`: the contract's isolation enum has only separate-user and same-user, and a word the
// hub's schema does not know would make the whole reply unreadable.
const IsolationSharedUID = "shared-uid"

// IsolationNodeUID: the station's agents run as the uid the node itself runs as.
const IsolationNodeUID = "node-uid"
