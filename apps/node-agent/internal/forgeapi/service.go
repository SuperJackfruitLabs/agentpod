package forgeapi

// The forge.api verbs, as operations on the node. The gateway handler (internal/gateway) only
// decodes frames and calls these.
//
// Failure convention, matching what the hub does with a reply: an operation that cannot do what
// was asked returns an error (the gateway turns it into an error response, which the hub reads
// as "refused" with the message), carrying a stable code first: `stk-missing: ...`. An
// operation returns an ack with ok:false only where the hub reads the ack's own error field
// (policy). Nothing returns ok:true unless stk confirmed it.
//
// Secrets: the sealed envelope is held as a Sealed (redacting) and reaches exactly one place,
// the stdin of `stk handover open`. It is never put in an error, a log line, an ack or the
// policy file.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// Sealed is an stk handover envelope. It prints as a placeholder however it is formatted.
type Sealed string

func (Sealed) String() string               { return "[sealed]" }
func (Sealed) GoString() string             { return "forgeapi.Sealed([sealed])" }
func (Sealed) MarshalJSON() ([]byte, error) { return []byte(`"[sealed]"`), nil }
func (s Sealed) Format(f fmt.State, _ rune) { _, _ = f.Write([]byte("[sealed]")) }

// HandoverPrefix is the start of an stk handover envelope; FORGE_API_SEALED_MAX in the contract.
const (
	HandoverPrefix = "stk-handover-v1:"
	SealedMax      = 16384
)

// DeliverParams is the forge.api.deliver frame (packages/contract/src/forge-api.ts).
type DeliverParams struct {
	StationID    string   `json:"stationId"`
	StationKey   string   `json:"stationKey"`
	GrantID      string   `json:"grantId"`
	Provider     string   `json:"provider"`
	Instance     string   `json:"instance"`
	Mode         string   `json:"mode"`
	ServiceName  string   `json:"serviceName"`
	Repositories []string `json:"repositories"`
	Preset       string   `json:"preset"`
	Rules        []Rule   `json:"rules"`
	AllowGraphql bool     `json:"allowGraphql"`
	Sealed       Sealed   `json:"sealed"`
	ExpectLogin  string   `json:"expectLogin"`
}

// PolicyParams is the forge.api.policy frame.
type PolicyParams struct {
	StationID    string `json:"stationId"`
	GrantID      string `json:"grantId"`
	Preset       string `json:"preset"`
	Rules        []Rule `json:"rules"`
	AllowGraphql bool   `json:"allowGraphql"`
}

// VerifyParams is the forge.api.verify frame.
type VerifyParams struct {
	StationID   string `json:"stationId"`
	GrantID     string `json:"grantId"`
	ExpectLogin string `json:"expectLogin"`
}

// RevokeParams is the forge.api.revoke frame.
type RevokeParams struct {
	StationID string `json:"stationId"`
	GrantID   string `json:"grantId"`
}

// StatusParams is the forge.api.status frame.
type StatusParams struct {
	StationID string `json:"stationId"`
}

// DeliverAck: the hub requires ok && stored. Reason is set only when isolation is degraded.
type DeliverAck struct {
	OK        bool   `json:"ok"`
	Stored    bool   `json:"stored"`
	Isolation string `json:"isolation"`
	Reason    string `json:"reason,omitempty"`
}

// PolicyAck: the hub reads ok and error.
type PolicyAck struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// VerifyAck: Reason is stk's reason code, unchanged. Bypass is filled by the optional bypass hook.
type VerifyAck struct {
	OK        bool   `json:"ok"`
	Login     string `json:"login,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Isolation string `json:"isolation"`
	Bypass    any    `json:"bypass,omitempty"`
}

// RevokeAck: Removed is false when there was nothing on this node to remove.
type RevokeAck struct {
	Removed bool `json:"removed"`
}

// StatusGrant: Present means the node holds a policy entry for the grant (not that the
// credential was verified; verify says that).
type StatusGrant struct {
	GrantID   string `json:"grantId"`
	Present   bool   `json:"present"`
	Isolation string `json:"isolation"`
}

// StatusAck carries the station's handover PUBLIC key even with no grants.
type StatusAck struct {
	Grants     []StatusGrant `json:"grants"`
	PublicKey  string        `json:"publicKey"`
	StkVersion string        `json:"stkVersion,omitempty"`
}

// CodedError is a failure with a stable code first in its message.
type CodedError struct {
	Code string
	Err  error
}

func (e *CodedError) Error() string { return e.Code + ": " + clean(e.Err.Error()) }
func (e *CodedError) Unwrap() error { return e.Err }

func coded(code string, err error) error { return &CodedError{Code: code, Err: err} }
func codedf(code, format string, a ...any) error {
	return &CodedError{Code: code, Err: fmt.Errorf(format, a...)}
}

// Service holds what the verbs need. All policy-file mutations are serialised by mu: stk reads
// the whole file on reload, so two interleaved edits could each be valid alone and still leave
// a file neither meant. (No file lock: the node is the only writer besides an operator editing
// by hand, which no lock of ours can order.)
type Service struct {
	// Ensure makes stk usable (the lazy setup from setup.go).
	Ensure func(context.Context) (SetupResult, error)
	// NewClient builds an stk client for the machine as it is now; called per operation, because
	// the client used before `stk install` has no RunAs and the one after does.
	NewClient func() stkclient.Client
	// PolicyPath is stk's policy file; DefaultPolicyPath when empty.
	PolicyPath string
	// Unwire removes the harness wiring for a grant (Task 5). Nil until then.
	Unwire func(grantID string) error
	// Bypass is the per-harness bypass check (Task 6); its result rides in the verify ack. Nil
	// until then.
	Bypass func(ctx context.Context, c stkclient.Client) any

	mu sync.Mutex
}

func (s *Service) path() string {
	if s.PolicyPath != "" {
		return s.PolicyPath
	}
	return DefaultPolicyPath
}

// isolationOf maps what setup learned to the contract's two words. Anything short of a
// protected separate-user broker (including an agent that runs as root) is "same-user": the hub
// is never told more protection than there is.
func isolationOf(res SetupResult) string {
	if res.Report.Isolation.Level == LevelSeparateUser && !res.Degraded {
		return "separate-user"
	}
	return "same-user"
}

// stkUnavailableCode is the stable reason code for "stk cannot be used at all", the same words the
// capability probe logs and the hub shows.
func stkUnavailableCode(err error) (string, bool) {
	switch {
	case errors.Is(err, stkclient.ErrStkMissing):
		return "stk-missing", true
	case errors.Is(err, stkclient.ErrStkTooOld):
		return "stk-too-old", true
	case errors.Is(err, stkclient.ErrStkNotRunnable):
		return "stk-not-runnable", true
	}
	return "", false
}

// ready ensures stk and returns a client built for the world as it is now.
func (s *Service) ready(ctx context.Context) (stkclient.Client, SetupResult, error) {
	if s.Ensure == nil || s.NewClient == nil {
		return nil, SetupResult{}, codedf("stk-unavailable", "forge API access is not configured on this node")
	}
	res, err := s.Ensure(ctx)
	if err != nil {
		code := "stk-setup-failed"
		if c, ok := stkUnavailableCode(err); ok {
			code = c
		}
		return nil, SetupResult{}, coded(code, err)
	}
	return s.NewClient(), res, nil
}

func checkNonEmpty(fields map[string]string) error {
	for _, k := range []string{"stationId", "stationKey", "grantId", "provider", "instance", "mode", "serviceName", "preset", "expectLogin"} {
		if v, ok := fields[k]; ok && strings.TrimSpace(v) == "" {
			return codedf("invalid-params", "%s is required", k)
		}
	}
	return nil
}

// refuseOtherStation is a TEMPORARY fail-closed guard. One node runs one stk with one proxy key,
// so every harness on the node can use every brokered credential: a second station's grant would
// let the first station's agent act as it (and vice versa). Until per-station isolation exists
// (one stk per station, or stk caller identity), a node serves a single station: deliver is
// refused while the policy holds managed entries labelled with a different station. Several
// grants for the same station are fine. Remove this when isolation lands.
func refuseOtherStation(policy []byte, station string) error {
	all, err := ManagedEntries(policy)
	if err != nil {
		return coded("policy-invalid", err)
	}
	for _, m := range all {
		if m.Station != station {
			return codedf("station-isolation-unsupported", "one broker per node currently serves a single station; this node already holds grants for another station")
		}
	}
	return nil
}

// Deliver stores the policy entry, opens the sealed credential into stk and reloads. On any
// failure after the file was written the file is put back byte for byte, so it never holds an
// entry stk did not accept.
//
// Known limit (availability only): the credential is replaced by HandoverOpen BEFORE the reload,
// so if the reload then rejects an update to an existing grant, the policy is restored but the
// previous credential is already gone. Re-delivering heals it; nothing is exposed.
func (s *Service) Deliver(ctx context.Context, p DeliverParams) (DeliverAck, error) {
	if err := checkNonEmpty(map[string]string{
		"stationId": p.StationID, "stationKey": p.StationKey, "grantId": p.GrantID, "provider": p.Provider,
		"instance": p.Instance, "mode": p.Mode, "serviceName": p.ServiceName, "preset": p.Preset,
		"expectLogin": p.ExpectLogin,
	}); err != nil {
		return DeliverAck{}, err
	}
	if !strings.HasPrefix(string(p.Sealed), HandoverPrefix) || len(p.Sealed) == len(HandoverPrefix) {
		return DeliverAck{}, codedf("invalid-params", "sealed is not an stk handover envelope")
	}
	if len(p.Sealed) > SealedMax {
		return DeliverAck{}, codedf("invalid-params", "sealed is larger than %d characters", SealedMax)
	}
	entry := PolicyEntry{
		Service: p.ServiceName, Provider: p.Provider, Instance: p.Instance, Mode: p.Mode,
		Repositories: p.Repositories, Preset: p.Preset, Rules: p.Rules, AllowGraphQL: p.AllowGraphql,
		Station: p.StationID, Grant: p.GrantID,
	}
	// Checked before anything is installed or written: a bad frame must not cost an install.
	if _, err := MergePolicy(nil, entry); err != nil {
		return DeliverAck{}, coded(entryCode(err), err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	client, res, err := s.ready(ctx)
	if err != nil {
		return DeliverAck{}, err
	}
	path := s.path()
	prev, existed, err := readPolicyFile(path)
	if err != nil {
		return DeliverAck{}, coded("policy-read-failed", err)
	}
	if err := refuseOtherStation(prev, p.StationID); err != nil {
		return DeliverAck{}, err
	}
	merged, err := MergePolicy(prev, entry)
	if err != nil {
		return DeliverAck{}, coded(entryCode(err), err)
	}
	_, hadEntry, err := FindGrant(prev, "", p.GrantID)
	if err != nil {
		return DeliverAck{}, coded("policy-invalid", err)
	}

	changed := !bytes.Equal(prev, merged)
	if changed {
		if err := writePolicyFile(path, merged); err != nil {
			return DeliverAck{}, coded("policy-write-failed", err)
		}
	}
	rollback := func() error {
		if !changed {
			return nil
		}
		return restorePolicyFile(path, prev, existed)
	}
	fail := func(code string, cause error) (DeliverAck, error) {
		if rbErr := rollback(); rbErr != nil {
			return DeliverAck{}, codedf(code, "%v; ROLLBACK FAILED, the policy file may hold an entry stk did not accept: %v", clean(cause.Error()), clean(rbErr.Error()))
		}
		return DeliverAck{}, coded(code, cause)
	}

	if err := client.HandoverOpen(ctx, p.ServiceName, string(p.Sealed)); err != nil {
		return fail("handover-failed", err)
	}
	if _, err := client.Reload(ctx); err != nil {
		code := "reload-failed"
		if errors.Is(err, stkclient.ErrReloadRejected) {
			code = "reload-rejected"
		}
		// The credential was stored before the reload. For a NEW entry stk refused, forget it
		// BEFORE the file is restored: stk resolves a service through the policy, so once the
		// entry is gone the forget cannot find it. Best effort; the next deliver replaces it.
		if !hadEntry {
			if rerr := client.RevokeLocal(ctx, p.ServiceName); rerr != nil {
				logf("forgeapi: could not forget the credential of a refused entry for grant %s", p.GrantID)
			}
		}
		return fail(code, err)
	}

	ack := DeliverAck{OK: true, Stored: true, Isolation: isolationOf(res)}
	if res.Degraded {
		ack.Reason = res.Reason
	}
	logf("forgeapi: delivered grant %s (isolation %s)", p.GrantID, ack.Isolation)
	return ack, nil
}

func entryCode(err error) string {
	switch {
	case errors.Is(err, ErrReservedName):
		return "reserved-service-name"
	case errors.Is(err, ErrConflict):
		return "policy-conflict"
	case errors.Is(err, ErrBadPolicyFile):
		return "policy-invalid"
	}
	return "invalid-entry"
}

// Policy replaces the preset, rules and allow_graphql of an existing grant and reloads. A
// rejected reload puts the file back.
func (s *Service) Policy(ctx context.Context, p PolicyParams) (PolicyAck, error) {
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" {
		return PolicyAck{}, codedf("invalid-params", "stationId and grantId are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.path()
	prev, existed, err := readPolicyFile(path)
	if err != nil {
		return PolicyAck{OK: false, Error: coded("policy-read-failed", err).Error()}, nil
	}
	updated, found, err := UpdatePolicy(prev, p.StationID, p.GrantID, p.Preset, p.Rules, p.AllowGraphql)
	if err != nil {
		return PolicyAck{OK: false, Error: coded("invalid-policy", err).Error()}, nil
	}
	if !found {
		return PolicyAck{OK: false, Error: "unknown-grant"}, nil
	}
	changed := !bytes.Equal(prev, updated)
	if changed {
		if err := writePolicyFile(path, updated); err != nil {
			return PolicyAck{OK: false, Error: coded("policy-write-failed", err).Error()}, nil
		}
	}
	if s.NewClient == nil {
		_ = restoreIf(changed, path, prev, existed)
		return PolicyAck{OK: false, Error: "stk-unavailable"}, nil
	}
	if _, err := s.NewClient().Reload(ctx); err != nil {
		code := "reload-failed"
		if errors.Is(err, stkclient.ErrReloadRejected) {
			code = "reload-rejected"
		} else if c, ok := stkUnavailableCode(err); ok {
			code = c
		}
		msg := coded(code, err).Error()
		if rbErr := restoreIf(changed, path, prev, existed); rbErr != nil {
			msg += "; ROLLBACK FAILED, the policy file may hold a rule stk did not accept: " + clean(rbErr.Error())
		}
		return PolicyAck{OK: false, Error: msg}, nil
	}
	return PolicyAck{OK: true}, nil
}

func restoreIf(changed bool, path string, prev []byte, existed bool) error {
	if !changed {
		return nil
	}
	return restorePolicyFile(path, prev, existed)
}

// Verify asks stk to make a real read call as the grant's credential. stk's reason codes pass
// through unchanged; a non-zero exit from stk still yields a structured answer when it printed
// one (the client parses stdout whatever the exit code).
func (s *Service) Verify(ctx context.Context, p VerifyParams) (VerifyAck, error) {
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" || strings.TrimSpace(p.ExpectLogin) == "" {
		return VerifyAck{}, codedf("invalid-params", "stationId, grantId and expectLogin are required")
	}
	client, res, err := s.ready(ctx)
	if err != nil {
		return VerifyAck{}, err
	}
	data, _, err := readPolicyFile(s.path())
	if err != nil {
		return VerifyAck{}, coded("policy-read-failed", err)
	}
	m, found, err := FindGrant(data, p.StationID, p.GrantID)
	if err != nil {
		return VerifyAck{}, coded("policy-invalid", err)
	}
	if !found {
		return VerifyAck{}, codedf("unknown-grant", "this node holds no entry for grant %s", p.GrantID)
	}
	vr, err := client.Verify(ctx, m.Service, p.ExpectLogin)
	if err != nil {
		return VerifyAck{}, coded("verify-failed", err)
	}
	ack := VerifyAck{OK: vr.OK, Login: vr.Login, Isolation: isolationOf(res)}
	if !vr.OK {
		ack.Reason = vr.Reason
		if ack.Reason == "" {
			ack.Reason = "unexpected-response"
		}
	}
	if s.Bypass != nil {
		ack.Bypass = s.Bypass(ctx, client)
	}
	return ack, nil
}

// Revoke wipes first: the credential is forgotten in stk while the entry is still in the policy
// (stk resolves the service through it), then the entry goes and stk reloads, then the harness
// wiring is removed. Each step is safe to repeat, and a grant this node does not hold succeeds.
func (s *Service) Revoke(ctx context.Context, p RevokeParams) (RevokeAck, error) {
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" {
		return RevokeAck{}, codedf("invalid-params", "stationId and grantId are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	data, _, err := readPolicyFile(s.path())
	if err != nil {
		return RevokeAck{}, coded("policy-read-failed", err)
	}
	m, found, err := FindGrant(data, p.StationID, p.GrantID)
	if err != nil {
		return RevokeAck{}, coded("policy-invalid", err)
	}
	if found {
		if s.NewClient == nil {
			return RevokeAck{}, codedf("stk-unavailable", "forge API access is not configured on this node")
		}
		// removeLocked unwires too.
		if err := s.removeLocked(ctx, s.NewClient(), []ManagedEntry{m}); err != nil {
			return RevokeAck{}, err
		}
		return RevokeAck{Removed: true}, nil
	}
	// Nothing in the policy, but the wiring may be left from an interrupted revoke.
	if s.Unwire != nil {
		if err := s.Unwire(p.GrantID); err != nil {
			return RevokeAck{}, coded("unwire-failed", err)
		}
	}
	return RevokeAck{Removed: false}, nil
}

// nothingToWithdraw is stk's answer when the credential is already gone.
func nothingToWithdraw(err error) bool {
	m := strings.ToLower(err.Error())
	return strings.Contains(m, "nothing to withdraw") || strings.Contains(m, "is not connected")
}

// removeLocked forgets the credentials, removes the entries, reloads and unwires. mu is held.
func (s *Service) removeLocked(ctx context.Context, client stkclient.Client, entries []ManagedEntry) error {
	grants := map[string]bool{}
	for _, m := range entries {
		if err := client.RevokeLocal(ctx, m.Service); err != nil && !nothingToWithdraw(err) {
			return coded("revoke-failed", err)
		}
		grants[m.Grant] = true
	}
	path := s.path()
	prev, existed, err := readPolicyFile(path)
	if err != nil {
		return coded("policy-read-failed", err)
	}
	updated, removed, err := RemoveEntries(prev, grants)
	if err != nil {
		return coded("policy-invalid", err)
	}
	if len(removed) > 0 {
		if err := writePolicyFile(path, updated); err != nil {
			return coded("policy-write-failed", err)
		}
		if _, err := client.Reload(ctx); err != nil {
			msg := err
			if rbErr := restorePolicyFile(path, prev, existed); rbErr != nil {
				msg = fmt.Errorf("%v; ROLLBACK FAILED: %v", clean(err.Error()), clean(rbErr.Error()))
			}
			// The credential is already gone; the entry stays until a retry gets a reload through.
			return coded("reload-failed", msg)
		}
	}
	if s.Unwire != nil {
		for _, m := range entries {
			if err := s.Unwire(m.Grant); err != nil {
				return coded("unwire-failed", err)
			}
		}
	}
	return nil
}

// PruneUnhosted removes the managed entries (and their credentials) of stations this node no
// longer hosts. An entry with no station label is not the node's to judge and is kept. It
// returns the grants it removed. Wiring it to the connect event is the caller's job.
func (s *Service) PruneUnhosted(ctx context.Context, hosted []string) ([]string, error) {
	keep := map[string]bool{}
	for _, h := range hosted {
		keep[h] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	data, _, err := readPolicyFile(s.path())
	if err != nil {
		return nil, coded("policy-read-failed", err)
	}
	all, err := ManagedEntries(data)
	if err != nil {
		return nil, coded("policy-invalid", err)
	}
	var stale []ManagedEntry
	for _, m := range all {
		if m.Station != "" && !keep[m.Station] {
			stale = append(stale, m)
		}
	}
	if len(stale) == 0 {
		return nil, nil
	}
	if s.NewClient == nil {
		return nil, codedf("stk-unavailable", "forge API access is not configured on this node")
	}
	if err := s.removeLocked(ctx, s.NewClient(), stale); err != nil {
		return nil, err
	}
	ids := make([]string, len(stale))
	for i, m := range stale {
		ids[i] = m.Grant
	}
	return ids, nil
}

// Status reports the station's handover public key (required by the hub, present with zero
// grants), the grants this node holds for the station and the isolation level. If the key
// cannot be read the whole call fails: a stale or empty key would make the hub seal to nothing.
func (s *Service) Status(ctx context.Context, p StatusParams) (StatusAck, error) {
	if strings.TrimSpace(p.StationID) == "" {
		return StatusAck{}, codedf("invalid-params", "stationId is required")
	}
	client, res, err := s.ready(ctx)
	if err != nil {
		return StatusAck{}, err
	}
	key, err := client.HandoverKey(ctx)
	if err != nil {
		return StatusAck{}, coded("handover-key-failed", err)
	}
	data, _, err := readPolicyFile(s.path())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return StatusAck{}, coded("policy-read-failed", err)
	}
	all, err := ManagedEntries(data)
	if err != nil {
		return StatusAck{}, coded("policy-invalid", err)
	}
	iso := isolationOf(res)
	ack := StatusAck{Grants: []StatusGrant{}, PublicKey: key}
	for _, m := range all {
		if m.Station == p.StationID {
			ack.Grants = append(ack.Grants, StatusGrant{GrantID: m.Grant, Present: true, Isolation: iso})
		}
	}
	if v, err := client.Version(ctx); err == nil {
		ack.StkVersion = v
	}
	return ack, nil
}
