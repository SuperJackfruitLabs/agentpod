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
	// IsolationDetail refines Isolation for readers that know it ("shared-uid"); the hub's schema
	// is lenient about extra result fields.
	IsolationDetail string `json:"isolationDetail,omitempty"`
	Reason          string `json:"reason,omitempty"`
}

// PolicyAck: the hub reads ok and error (station-forge-api.ts: "node rejected the policy: <error>"),
// so a policy failure is an ack with ok:false and the coded text in error, not a Go error like the
// other verbs'. Only a malformed frame (invalid-params) is an error.
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
	// IsolationDetail: see DeliverAck.
	IsolationDetail string `json:"isolationDetail,omitempty"`
	Bypass          any    `json:"bypass,omitempty"`
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
	// IsolationDetail: see DeliverAck.
	IsolationDetail string `json:"isolationDetail,omitempty"`
}

// StatusAck carries the station's handover PUBLIC key even with no grants.
type StatusAck struct {
	Grants     []StatusGrant `json:"grants"`
	PublicKey  string        `json:"publicKey"`
	StkVersion string        `json:"stkVersion,omitempty"`
	// Warnings are problems that do not stop the station working (the shared base policy could
	// not be copied in, stations share an agent uid). The hub's result schema is lenient, so an
	// older hub ignores them.
	Warnings []string `json:"warnings,omitempty"`
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
	// SharedPolicyPath is the node-level shared base policy (shared.go); empty or absent means
	// none. Its entries are copied into PolicyPath on every policy write.
	SharedPolicyPath string
	// Station, when set, binds this Service to one station's stk instance: a frame for any other
	// station is refused before anything is read or run. (StationInstances sets it.)
	Station string
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
// lockForRemoval blocks every verb on this Service until the returned func is called, after the
// ones in flight have finished.
func (s *Service) lockForRemoval() func() {
	s.mu.Lock()
	return s.mu.Unlock
}

func (s *Service) ready(ctx context.Context) (stkclient.Client, SetupResult, error) {
	if s.Ensure == nil || s.NewClient == nil {
		return nil, SetupResult{}, codedf("stk-unavailable", "forge API access is not configured on this node")
	}
	res, err := s.Ensure(ctx)
	if err != nil {
		code := "stk-setup-failed"
		if c, ok := stkUnavailableCode(err); ok {
			code = c
		} else if errors.Is(err, ErrInstanceUnavailable) {
			code = "station-instance-unavailable"
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

// checkStation refuses a frame meant for another station than the one this Service serves.
func (s *Service) checkStation(station string) error {
	if s.Station != "" && station != s.Station {
		return codedf("station-mismatch", "this stk instance serves another station")
	}
	return nil
}

// sharedBytes reads the shared base policy; a missing file is "no shared entries".
func (s *Service) sharedBytes() ([]byte, error) {
	if s.SharedPolicyPath == "" {
		return nil, nil
	}
	b, _, err := readPolicyFile(s.SharedPolicyPath)
	return b, err
}

// forgetDropped forgets the credential of every shared copy that prev holds and next no longer
// does. It runs BEFORE the policy file changes: stk resolves a service through the policy, so once
// the entry is gone the forget could not find it.
func (s *Service) forgetDropped(ctx context.Context, client stkclient.Client, prev, next []byte) error {
	still := map[string]bool{}
	for _, n := range SharedServices(next) {
		still[n] = true
	}
	for _, n := range SharedServices(prev) {
		if still[n] {
			continue
		}
		if err := client.RevokeLocal(ctx, n); err != nil && !nothingToWithdraw(err) {
			return coded("revoke-failed", err)
		}
	}
	return nil
}

// RefreshShared brings this station's shared copies in line with the shared base policy without a
// grant being written: a service the operator removed leaves the policy and its credential is
// forgotten first; a changed one is rewritten. No policy file means nothing to do.
func (s *Service) RefreshShared(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := s.path()
	prev, existed, err := readPolicyFile(path)
	if err != nil {
		return coded("policy-read-failed", err)
	}
	if !existed {
		return nil
	}
	next, err := s.withShared(prev, s.Station, true)
	if err != nil {
		return err
	}
	if bytes.Equal(prev, next) {
		return nil
	}
	if s.NewClient == nil {
		return codedf("stk-unavailable", "forge API access is not configured on this node")
	}
	client := s.NewClient()
	if err := s.forgetDropped(ctx, client, prev, next); err != nil {
		return err
	}
	if err := writePolicyFile(path, next); err != nil {
		return coded("policy-write-failed", err)
	}
	if _, err := client.Reload(ctx); err != nil {
		code := "reload-failed"
		if errors.Is(err, stkclient.ErrReloadRejected) {
			code = "reload-rejected"
		}
		if rbErr := restorePolicyFile(path, prev, existed); rbErr != nil {
			return codedf(code, "%v; ROLLBACK FAILED: %v", clean(err.Error()), clean(rbErr.Error()))
		}
		return coded(code, err)
	}
	return nil
}

// withShared brings prev's shared entries in line with the shared file. strict: an unusable
// shared file is an error (writes that add or change something); otherwise it is logged and prev
// is returned (a revoke must not be blocked by an operator's broken file).
func (s *Service) withShared(prev []byte, station string, strict bool) ([]byte, error) {
	shared, err := s.sharedBytes()
	var out []byte
	if err == nil {
		var skipped []string
		out, skipped, err = ApplyShared(prev, shared, station)
		for _, sk := range skipped {
			logf("forgeapi: shared base policy entry skipped for the station: %s", sk)
		}
	}
	if err != nil {
		if strict {
			return nil, coded("shared-policy-invalid", err)
		}
		logf("forgeapi: shared base policy not applied: %v", clean(err.Error()))
		return prev, nil
	}
	return out, nil
}

// Deliver stores the policy entry, opens the sealed credential into stk and reloads. On any
// failure after the file was written the file is put back byte for byte, so it never holds an
// entry stk did not accept.
//
// Known limit (availability only): the credential is replaced by HandoverOpen BEFORE the reload,
// so if the reload then rejects an update to an existing grant, the policy is restored but the
// previous credential is already gone. Re-delivering heals it; nothing is exposed.
// validateDeliver checks a deliver frame before anything is installed, read or written, and
// returns the policy entry it describes.
func validateDeliver(p DeliverParams) (PolicyEntry, error) {
	if err := checkNonEmpty(map[string]string{
		"stationId": p.StationID, "stationKey": p.StationKey, "grantId": p.GrantID, "provider": p.Provider,
		"instance": p.Instance, "mode": p.Mode, "serviceName": p.ServiceName, "preset": p.Preset,
		"expectLogin": p.ExpectLogin,
	}); err != nil {
		return PolicyEntry{}, err
	}
	if !strings.HasPrefix(string(p.Sealed), HandoverPrefix) || len(p.Sealed) == len(HandoverPrefix) {
		return PolicyEntry{}, codedf("invalid-params", "sealed is not an stk handover envelope")
	}
	if len(p.Sealed) > SealedMax {
		return PolicyEntry{}, codedf("invalid-params", "sealed is larger than %d characters", SealedMax)
	}
	entry := PolicyEntry{
		Service: p.ServiceName, Provider: p.Provider, Instance: p.Instance, Mode: p.Mode,
		Repositories: p.Repositories, Preset: p.Preset, Rules: p.Rules, AllowGraphQL: p.AllowGraphql,
		Station: p.StationID, Grant: p.GrantID,
	}
	// Checked before anything is installed or written: a bad frame must not cost an install.
	if _, err := MergePolicy(nil, entry); err != nil {
		return PolicyEntry{}, coded(entryCode(err), err)
	}
	return entry, nil
}

func (s *Service) Deliver(ctx context.Context, p DeliverParams) (DeliverAck, error) {
	entry, err := validateDeliver(p)
	if err != nil {
		return DeliverAck{}, err
	}
	if err := s.checkStation(p.StationID); err != nil {
		return DeliverAck{}, err
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
	base, err := s.withShared(prev, p.StationID, true)
	if err != nil {
		return DeliverAck{}, err
	}
	merged, err := MergePolicy(base, entry)
	if err != nil {
		return DeliverAck{}, coded(entryCode(err), err)
	}
	if err := s.forgetDropped(ctx, client, prev, merged); err != nil {
		return DeliverAck{}, err
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
	if err := s.checkStation(p.StationID); err != nil {
		return PolicyAck{OK: false, Error: err.Error()}, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.path()
	prev, existed, err := readPolicyFile(path)
	if err != nil {
		return PolicyAck{OK: false, Error: coded("policy-read-failed", err).Error()}, nil
	}
	base, err := s.withShared(prev, p.StationID, true)
	if err != nil {
		return PolicyAck{OK: false, Error: err.Error()}, nil
	}
	updated, found, err := UpdatePolicy(base, p.StationID, p.GrantID, p.Preset, p.Rules, p.AllowGraphql)
	if err != nil {
		return PolicyAck{OK: false, Error: coded("invalid-policy", err).Error()}, nil
	}
	if !found {
		return PolicyAck{OK: false, Error: "unknown-grant"}, nil
	}
	changed := !bytes.Equal(prev, updated)
	if changed && s.NewClient != nil {
		if err := s.forgetDropped(ctx, s.NewClient(), prev, updated); err != nil {
			return PolicyAck{OK: false, Error: err.Error()}, nil
		}
	}
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
	if err := s.checkStation(p.StationID); err != nil {
		return VerifyAck{}, err
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
	if err := s.checkStation(p.StationID); err != nil {
		return RevokeAck{}, err
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
	station := ""
	if len(entries) > 0 {
		station = entries[0].Station
	}
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
		if station != "" {
			updated, _ = s.withShared(updated, station, false)
		}
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

// Status reports the station's handover public key (required by the hub, present with zero
// grants), the grants this node holds for the station and the isolation level. If the key
// cannot be read the whole call fails: a stale or empty key would make the hub seal to nothing.
func (s *Service) Status(ctx context.Context, p StatusParams) (StatusAck, error) {
	if strings.TrimSpace(p.StationID) == "" {
		return StatusAck{}, codedf("invalid-params", "stationId is required")
	}
	if err := s.checkStation(p.StationID); err != nil {
		return StatusAck{}, err
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
