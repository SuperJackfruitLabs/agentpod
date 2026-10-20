package mcpproxy

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Identity is private proxy metadata derived from the existing admitted root binding.
// It issues no token and adds no audience. BindingDigest includes the principal, run and epoch.
type Identity struct {
	BindingDigest  string `json:"binding_digest"`
	OrganizationID string `json:"organization_id"`
	PrincipalID    string `json:"principal_id"`
	OccupancyEpoch int64  `json:"occupancy_epoch"`
}

func (i Identity) valid() bool {
	return regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(i.BindingDigest) && regexp.MustCompile(`^org_[a-f0-9]{20}$`).MatchString(i.OrganizationID) && regexp.MustCompile(`^prn_[a-f0-9]{20}$`).MatchString(i.PrincipalID) && i.OccupancyEpoch > 0 && i.OccupancyEpoch <= 9007199254740991
}
func (s *Store) BindIdentity(station string, identity Identity) (string, int64, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !identity.valid() {
		return "", 0, false, fmt.Errorf("mcpproxy: malformed managed identity")
	}
	unlock, err := lockStore(s.path)
	if err != nil {
		return "", 0, false, err
	}
	defer unlock()
	if err := s.refreshLocked(); err != nil {
		return "", 0, false, err
	}
	if s.st.Secrets[station] == "" {
		return "", 0, false, fmt.Errorf("mcpproxy: station is not assigned")
	}
	if old, ok := s.st.Identities[station]; ok {
		if old == identity {
			return s.st.Secrets[station], s.st.Generations[station], false, nil
		}
		if old.OrganizationID != identity.OrganizationID || old.OccupancyEpoch > identity.OccupancyEpoch || (old.OccupancyEpoch == identity.OccupancyEpoch && old.PrincipalID != identity.PrincipalID) || old.BindingDigest == identity.BindingDigest {
			return "", 0, false, fmt.Errorf("mcpproxy: stale or conflicting managed identity")
		}
	}
	generation := s.st.Generations[station]
	if generation == 0 {
		generation = 1
	}
	if generation >= 9007199254740991 {
		return "", 0, false, fmt.Errorf("mcpproxy: credential generation exhausted")
	}
	key, err := newSecret()
	if err != nil {
		return "", 0, false, err
	}
	s.st.Secrets[station], s.st.Generations[station], s.st.Identities[station] = key, generation+1, identity
	if err := s.saveLocked(); err != nil {
		return "", 0, false, err
	}
	// Return this exact transaction's snapshot; a later handoff can only invalidate this key.
	return key, generation + 1, true, nil
}
func (p *Proxy) BindIdentity(station string, identity Identity) ([]Server, error) {
	if !p.Serves(station) {
		return nil, fmt.Errorf("mcpproxy: station is not served")
	}
	key, generation, changed, err := p.store.BindIdentity(station, identity)
	if err != nil {
		return nil, err
	}
	if changed {
		p.invalidateToken(station)
	}
	servers := p.servers(station, key, generation)
	for i := range servers {
		servers[i].URL = strings.Replace(servers[i].URL, "/mcp/", "/mcp-managed-v1/"+identity.BindingDigest+"/", 1)
	}
	return servers, nil
}
func (p *Proxy) invalidateToken(station string) {
	if cache, ok := p.tokens.(interface{ Invalidate(string) }); ok {
		cache.Invalidate(station)
	}
}

// Binding check only: tokens come from the node's trusted TokenSource. The upstream still
// verifies the plane signature, issuer, audience and entitlement using its existing verifier.
func tokenMatchesIdentity(token string, identity *Identity) bool {
	if identity == nil {
		return true
	}
	if len(token) > 32768 {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Sub  string `json:"sub"`
		Org  string `json:"org"`
		Kind string `json:"principalKind"`
	}
	return json.Unmarshal(payload, &claims) == nil && claims.Kind == "agent" && claims.Sub == identity.PrincipalID && claims.Org == identity.OrganizationID
}
func sameIdentity(a, b *Identity) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
func sameCredential(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
