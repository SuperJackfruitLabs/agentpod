package forgeapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi/stkpolicy"
)

type stationState struct {
	inst Instance
	svc  *Service
}

// record is what the registry file keeps per instance. No secret, ever.
type record struct {
	Station string `json:"station"`
	Name    string `json:"name"`
	Port    int    `json:"port"`
	// AgentUIDs are the uids the station's agents ran as when the instance was last used; the
	// next station's uids are compared with them.
	AgentUIDs []int `json:"agentUids,omitempty"`
	// StationKey is the node's key for the station's harness ("hermes:press"), recorded at deliver
	// so a spawn, which knows only the key, finds the station's instance. Not a secret.
	StationKey string `json:"stationKey,omitempty"`
}

type registryFile struct {
	Version   int      `json:"version"`
	ManagedBy string   `json:"managedBy"`
	Instances []record `json:"instances"`
}

func osUserExists(name string) bool { _, err := user.Lookup(name); return err == nil }

func tcpPortFree(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

// ---- naming ----

func slugOf(station string) string {
	var b strings.Builder
	dash := true // no leading dash
	for _, r := range strings.ToLower(station) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	s := b.String()
	if len(s) > maxSlug {
		s = s[:maxSlug]
	}
	s = strings.TrimRight(s, "-")
	if s == "" {
		s = "st"
	}
	return s
}

// instanceName is stk-<slug>-<hex of sha256(station)>, with hexLen hex characters.
func instanceName(station string, hexLen int) string {
	sum := sha256.Sum256([]byte(station))
	return "stk-" + slugOf(station) + "-" + hex.EncodeToString(sum[:])[:hexLen]
}

func checkStationID(id string) error {
	if strings.TrimSpace(id) == "" {
		return codedf("invalid-params", "stationId is required")
	}
	if len(id) > maxStationID {
		return codedf("invalid-params", "stationId is longer than %d bytes", maxStationID)
	}
	for _, r := range id {
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			return codedf("invalid-params", "stationId contains a control character")
		}
	}
	return nil
}

func (m *StationInstances) instanceFor(r record) Instance {
	return Instance{
		Station: r.Station, Name: r.Name, Port: r.Port,
		StateDir:   filepath.Join(m.cfg.StateRoot, r.Name),
		RuntimeDir: filepath.Join(m.cfg.RuntimeRoot, r.Name),
		ConfigPath: filepath.Join(m.cfg.ConfigRoot, r.Name, "supertoolkit.yaml"),
	}
}

// ---- registry ----

// readRecords reads and validates the registry as it is on disk right now.
func (m *StationInstances) readRecords() (map[string]record, error) {
	data, _, err := stkpolicy.ReadPolicyFile(m.cfg.RegistryPath)
	if err != nil {
		return nil, coded("registry-unreadable", err)
	}
	recs := map[string]record{}
	if len(strings.TrimSpace(string(data))) > 0 {
		var f registryFile
		if err := json.Unmarshal(data, &f); err != nil {
			return nil, coded("registry-invalid", fmt.Errorf("%s is not valid JSON; fix or remove it by hand: %v", m.cfg.RegistryPath, err))
		}
		if f.Version != registryVersion || f.ManagedBy != registryMarker {
			return nil, codedf("registry-invalid", "%s is not this node's registry (version %d, managedBy %q)", m.cfg.RegistryPath, f.Version, f.ManagedBy)
		}
		names, ports := map[string]bool{}, map[int]bool{}
		for _, r := range f.Instances {
			if r.Station == "" || !instanceNameRE.MatchString(r.Name) || r.Port < 1 || r.Port > 65535 || names[r.Name] || ports[r.Port] || recs[r.Station].Name != "" || !validUIDs(r.AgentUIDs) {
				return nil, codedf("registry-invalid", "%s holds an entry the node did not write; fix or remove it by hand", m.cfg.RegistryPath)
			}
			names[r.Name], ports[r.Port] = true, true
			recs[r.Station] = r
		}
	}
	return recs, nil
}

func validUIDs(uids []int) bool {
	for _, u := range uids {
		if u < 0 || int64(u) > maxUID {
			return false
		}
	}
	return true
}

// writeRecords replaces the registry file. The caller holds the registry lock.
func (m *StationInstances) writeRecords(recs map[string]record) error {
	f := registryFile{Version: registryVersion, ManagedBy: registryMarker, Instances: []record{}}
	for _, r := range recs {
		f.Instances = append(f.Instances, r)
	}
	sort.Slice(f.Instances, func(i, j int) bool { return f.Instances[i].Port < f.Instances[j].Port })
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(m.cfg.RegistryPath, append(b, '\n'), 0o600)
}

// updateRecords runs fn on the registry as it is on disk under the registry lock and writes it
// back when fn says it changed it. Every change to the registry goes through here, so a record
// another process wrote a moment ago is never lost to a stale copy.
func (m *StationInstances) updateRecords(fn func(recs map[string]record) (changed bool, err error)) error {
	unlock, err := lockRegistry(m.cfg.RegistryPath)
	if err != nil {
		return coded("registry-lock-failed", err)
	}
	defer unlock()
	recs, err := m.readRecords()
	if err != nil {
		return err
	}
	changed, err := fn(recs)
	if err != nil || !changed {
		return err
	}
	if err := m.writeRecords(recs); err != nil {
		return coded("registry-write-failed", err)
	}
	return nil
}

func sameUIDs(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	x := append([]int(nil), a...)
	y := append([]int(nil), b...)
	sort.Ints(x)
	sort.Ints(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// sharesUID reports whether the station's uids overlap those of any OTHER registered instance.
func sharesUID(recs map[string]record, station string, uids []int) bool {
	for st, r := range recs {
		if st == station {
			continue
		}
		for _, u := range uids {
			for _, v := range r.AgentUIDs {
				if u == v {
					return true
				}
			}
		}
	}
	return false
}

// writeFileAtomic replaces path via a temporary file in the same directory, fsynced and renamed.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".registry-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error { _ = tmp.Close(); _ = os.Remove(name); return err }
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Chmod(mode); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// allocate picks the station's name and port in recs (the registry as just read under the lock).
// A name another station already holds (a hash prefix collision) is lengthened until it is free.
func (m *StationInstances) allocate(recs map[string]record, station string, uids []int) (record, error) {
	taken := map[string]bool{}
	usedPorts := map[int]bool{}
	for _, r := range recs {
		taken[r.Name] = true
		usedPorts[r.Port] = true
	}
	name := ""
	for n := minHex; n <= maxHex; n += 2 {
		if c := instanceName(station, n); !taken[c] {
			name = c
			break
		}
	}
	if name == "" {
		return record{}, codedf("instance-name-collision", "no free instance name for this station id")
	}
	for p := m.cfg.PortMin; p <= m.cfg.PortMax; p++ {
		if usedPorts[p] || !m.cfg.portFree(p) {
			continue
		}
		return record{Station: station, Name: name, Port: p, AgentUIDs: append([]int(nil), uids...)}, nil
	}
	return record{}, codedf("port-range-exhausted", "no free stk proxy port between %d and %d for this station; widen the range or remove stations that are gone", m.cfg.PortMin, m.cfg.PortMax)
}
