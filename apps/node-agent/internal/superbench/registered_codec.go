package superbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
)

const RegisteredWorkerVersion = "agentpod.registered-worker.v1"
const RegisteredLayoutVersion = "superbench.payload-layout.v1"

var ErrRegisteredFrame = errors.New("registered worker refused: frame")
var ErrRegisteredLayout = errors.New("registered worker refused: layout")
var ErrRegisteredTask = errors.New("registered worker refused: task")
var ErrRegisteredResult = errors.New("registered worker refused: result")

// Physical numbers are canonical decimal strings; a JSON intermediary must not
// round a uint64 inode. These observations grant no execution authority.
type RegisteredNode struct {
	Device string `json:"device"`
	Inode  string `json:"inode"`
}
type RegisteredMember struct {
	Name     string         `json:"name"`
	Checkout RegisteredNode `json:"checkout"`
	Admin    RegisteredNode `json:"admin"`
	Home     RegisteredNode `json:"home"`
	Temp     RegisteredNode `json:"tmp"`
}
type RegisteredLayout struct {
	Key          string             `json:"key"`
	BenchID      string             `json:"bench_id"`
	Version      string             `json:"version"`
	PolicySHA256 string             `json:"policy_sha256"`
	Root         RegisteredNode     `json:"root"`
	RootHome     RegisteredNode     `json:"root_home"`
	RootTemp     RegisteredNode     `json:"root_tmp"`
	Members      []RegisteredMember `json:"members"`
}

// RegisteredCapsule contains task data, never a lease/grant, source admission,
// reporter credential or Node private context. The producer must independently
// bind this exact digest and current registration/vector before actual launch.
type RegisteredCapsule struct {
	Version string            `json:"version"`
	Task    GroupedWorkerSpec `json:"task"`
	Layout  RegisteredLayout  `json:"layout"`
}

func nodeNumber(s string) (uint64, bool) {
	n, e := strconv.ParseUint(s, 10, 64)
	return n, e == nil && n != 0 && strconv.FormatUint(n, 10) == s
}
func (c RegisteredCapsule) validate() error {
	if c.Version != RegisteredWorkerVersion || validateGrouped(c.Task) != nil {
		return ErrRegisteredFrame
	}
	l := c.Layout
	if l.Key != c.Task.BenchKey || l.BenchID != c.Task.BenchID || l.Version != RegisteredLayoutVersion || !groupedDigest.MatchString(l.PolicySHA256) || len(l.Members) != len(c.Task.Members) {
		return ErrRegisteredLayout
	}
	seen := map[RegisteredNode]bool{}
	nodes := []RegisteredNode{l.Root, l.RootHome, l.RootTemp}
	for i, m := range l.Members {
		if m.Name != c.Task.Members[i].Name {
			return ErrRegisteredLayout
		}
		nodes = append(nodes, m.Checkout, m.Admin, m.Home, m.Temp)
	}
	for _, n := range nodes {
		if _, ok := nodeNumber(n.Device); !ok {
			return ErrRegisteredLayout
		}
		if _, ok := nodeNumber(n.Inode); !ok || n.Device != l.Root.Device || seen[n] {
			return ErrRegisteredLayout
		}
		seen[n] = true
	}
	return nil
}
func (c RegisteredCapsule) Bytes() ([]byte, error) {
	if err := c.validate(); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(c)
	if err != nil || len(raw) > MaxWorker {
		return nil, ErrRegisteredFrame
	}
	return raw, nil
}
func ParseRegisteredCapsule(raw []byte) (RegisteredCapsule, error) {
	var c RegisteredCapsule
	if len(raw) > MaxWorker || strictWorkerJSON(raw, &c) != nil {
		return c, ErrRegisteredFrame
	}
	canonical, err := c.Bytes()
	if err != nil {
		return RegisteredCapsule{}, err
	}
	if !bytes.Equal(raw, canonical) {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	return c, nil
}
