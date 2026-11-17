package benchworkspace

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const LayoutVersion = "superbench.payload-layout.v1"

// RegistrationObserveRequest is the PROPOSED private operator read of the
// currently held grouped registration. It has no request ID and no effects.
type RegistrationObserveRequest struct {
	Version    string `json:"version"`
	Operation  string `json:"operation"`
	Key        string `json:"key"`
	BenchID    string `json:"bench_id"`
	Holder     string `json:"holder"`
	LeaseToken string `json:"lease_token"`
}
type RegistrationNode struct {
	Device string `json:"device"`
	Inode  string `json:"inode"`
}
type RegistrationMember struct {
	Name     string           `json:"name"`
	Checkout RegistrationNode `json:"checkout"`
	Admin    RegistrationNode `json:"admin"`
	Home     RegistrationNode `json:"home"`
	Temp     RegistrationNode `json:"tmp"`
}
type RegistrationCheckpoint struct {
	GenerationID   string   `json:"generation_id"`
	Seal           string   `json:"seal"`
	ManifestSHA256 string   `json:"manifest_sha256"`
	Members        []Commit `json:"members"`
}

// RegistrationObservation is private task-preparation data. Knowing it grants
// no execution; the producer independently rechecks layout before launch.
type RegistrationObservation struct {
	Key           string                 `json:"key"`
	BenchID       string                 `json:"bench_id"`
	RootPath      string                 `json:"root_path"`
	LayoutVersion string                 `json:"layout_version"`
	PolicySHA256  string                 `json:"policy_sha256"`
	Root          RegistrationNode       `json:"root"`
	RootHome      RegistrationNode       `json:"root_home"`
	RootTemp      RegistrationNode       `json:"root_tmp"`
	Members       []RegistrationMember   `json:"members"`
	Checkpoint    RegistrationCheckpoint `json:"checkpoint"`
}
type RegistrationObserveResponse struct {
	Version   string                   `json:"version"`
	Operation string                   `json:"operation"`
	OK        bool                     `json:"ok"`
	Result    *RegistrationObservation `json:"result,omitempty"`
	Error     *APIError                `json:"error,omitempty"`
}

func (r RegistrationObserveRequest) valid() bool {
	return r.Version == Version && r.Operation == "registration_observe" && keyPattern.MatchString(r.Key) && idPattern.MatchString(r.BenchID) && holderPattern.MatchString(r.Holder) && tokenPattern.MatchString(r.LeaseToken)
}
func (r RegistrationObserveRequest) Bytes() ([]byte, error) {
	if !r.valid() {
		return nil, ErrInvalid
	}
	return json.Marshal(r)
}

func registrationNumber(s string) bool {
	n, err := strconv.ParseUint(s, 10, 64)
	return err == nil && n != 0 && strconv.FormatUint(n, 10) == s
}

// ParseRegistrationObserveResponse joins shape and complete identity only.
func ParseRegistrationObserveResponse(raw []byte, status int, request RegistrationObserveRequest) (RegistrationObserveResponse, error) {
	var zero RegistrationObserveResponse
	if !request.valid() || len(raw) > MaxBody || !utf8.Valid(raw) || !scalarEscapes(raw) || !strictJSON(raw) {
		return zero, ErrResponse
	}
	fields, ok := fieldSet(raw, []string{"version", "operation", "ok"}, []string{"result", "error"})
	if !ok {
		return zero, ErrResponse
	}
	var r RegistrationObserveResponse
	if decodeResponseObject(raw, &r) != nil || r.Version != Version || r.Operation != "registration_observe" || r.OK == (r.Error != nil) || r.OK != (r.Result != nil) {
		return zero, ErrResponse
	}
	if !r.OK {
		if r.Error.Message == "" || len(r.Error.Message) > 256 || !validHTTPError(r.Error.Code, status) {
			return zero, ErrResponse
		}
		return r, nil
	}
	o := r.Result
	if status != 200 || o.Key != request.Key || o.BenchID != request.BenchID || o.LayoutVersion != LayoutVersion || !digestPattern.MatchString(o.PolicySHA256) {
		return zero, ErrResponse
	}
	if len(o.RootPath) > 4096 || !filepath.IsAbs(o.RootPath) || filepath.Clean(o.RootPath) != o.RootPath || strings.ContainsRune(o.RootPath, 0) || filepath.Base(o.RootPath) != o.Key || filepath.Base(filepath.Dir(o.RootPath)) != "benches" {
		return zero, ErrResponse
	}
	c := o.Checkpoint
	if !idPattern.MatchString(c.GenerationID) || !digestPattern.MatchString(c.ManifestSHA256) || !commitPattern.MatchString(c.Seal) || len(o.Members) < 1 || len(o.Members) > 32 || len(c.Members) != len(o.Members) {
		return zero, ErrResponse
	}
	seen := map[RegistrationNode]bool{}
	nodes := []RegistrationNode{o.Root, o.RootHome, o.RootTemp}
	for i, m := range o.Members {
		if !namePattern.MatchString(m.Name) || i > 0 && o.Members[i-1].Name >= m.Name || c.Members[i].Name != m.Name || !commitPattern.MatchString(c.Members[i].Commit) {
			return zero, ErrResponse
		}
		nodes = append(nodes, m.Checkout, m.Admin, m.Home, m.Temp)
	}
	for _, n := range nodes {
		if !registrationNumber(n.Device) || !registrationNumber(n.Inode) || n.Device != o.Root.Device || seen[n] {
			return zero, ErrResponse
		}
		seen[n] = true
	}
	if _, ok = fieldSet(fields["result"], []string{"key", "bench_id", "root_path", "layout_version", "policy_sha256", "root", "root_home", "root_tmp", "members", "checkpoint"}, nil); !ok {
		return zero, ErrResponse
	}
	return r, nil
}
