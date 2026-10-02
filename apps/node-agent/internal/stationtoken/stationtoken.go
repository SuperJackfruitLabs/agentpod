// Package stationtoken keeps a station's hub token fresh on disk, so an agent can
// spend it without ever holding the node's credential.
//
// A station token is how an agent reaches a work plane as itself: `sub` is the station's
// principal, `principalKind` is `agent`, and it carries that principal's `mayDispatch` —
// the dispatch grant, which superpipeline checks when the agent queues work. The node
// mints it by spending its own enrollment secret on the station's behalf
// (`POST /api/nodes/:nodeId/stations/:stationId/token`).
//
// **Why a file, refreshed, rather than a value in the agent's environment.** The token
// lives five minutes — "the expiry IS the revocation SLA", because verification is offline
// and there is no revocation list. A value exported into a long-lived gateway process is
// therefore stale within minutes and stays stale. A file re-read per invocation is always
// current, and a client that reads it holds no secret of the node's. Same reasoning as
// `Config.OpenClawTokenFile`: "the token is passed as a FILE PATH, never inline — argv is
// world-readable."
//
// **Why the operator names the stations.** The node cannot discover its own station ids:
// `GET /api/nodes/:nodeId/stations` authenticates a human, not a node credential. Rather
// than add a discovery endpoint, each station that should hold a work-plane credential is
// named in the node's config — which is also the safer default, since a token that reaches
// another plane is not something every station should silently acquire.
package stationtoken

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Want is one station whose token this node keeps on disk.
type Want struct {
	// StationID is the hub's id for the station — the path segment the mint takes.
	StationID string `json:"stationId"`
	// Path is where the token is written. The agent's own config points at this.
	Path string `json:"path"`
}

// refreshFloor is how long a token must still have left for a pass to leave it alone.
//
// The TTL is five minutes. Refreshing with two minutes left means a token is replaced
// after roughly three, so a consumer reading at any moment has at least two minutes of
// validity — enough for a slow request to finish with the token it started with. Waiting
// until the last seconds would hand out credentials that expire mid-flight.
const refreshFloor = 2 * time.Minute

// pollInterval is how often a pass runs. Short relative to `refreshFloor`, so a transient
// mint failure is retried several times before any token actually dies.
const pollInterval = 30 * time.Second

// Keeper mints and rewrites the tokens named in a node's config.
type Keeper struct {
	Hub        string
	NodeID     string
	NodeSecret string
	Wants      []Want
	Client     *http.Client
}

// Run refreshes on a ticker until ctx ends. It returns only when ctx does: a mint failure
// is logged and retried, never fatal, for the reason every other node loop gives — one
// failing job must not take down the agent that the rest of the fleet depends on.
func (k *Keeper) Run(ctx context.Context) {
	k.once(ctx)
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			k.once(ctx)
		}
	}
}

func (k *Keeper) once(ctx context.Context) {
	for _, w := range k.Wants {
		if !k.needsRefresh(w.Path) {
			continue
		}
		if err := k.refresh(ctx, w); err != nil {
			// Named, with the station, because a silent failure here looks to the agent
			// exactly like a token that was never configured.
			log.Printf("station token %s: %v", w.StationID, err)
		}
	}
}

// needsRefresh reads what is on disk and decides. An unreadable or unparsable file needs a
// refresh — the point is to end up with a usable token, not to diagnose the old one.
func (k *Keeper) needsRefresh(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return true
	}
	exp, ok := expiryOf(strings.TrimSpace(string(raw)))
	if !ok {
		return true
	}
	return time.Until(exp) < refreshFloor
}

// expiryOf reads `exp` out of a JWT without verifying it.
//
// Deliberately NOT a verification: this decides when to replace a token the node itself
// just fetched, and the only question is how long it has left. Verification is the far
// end's job, against the hub's JWKS, and doing a shallow version of it here would be the
// kind of half-check that reads as a guarantee.
func expiryOf(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp == 0 {
		return time.Time{}, false
	}
	return time.Unix(claims.Exp, 0), true
}

func (k *Keeper) refresh(ctx context.Context, w Want) error {
	url := strings.TrimRight(k.Hub, "/") + "/api/nodes/" + k.NodeID + "/stations/" + w.StationID + "/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return err
	}
	// The node's own credential, spent on the station's behalf. It goes to the hub and
	// nowhere else, and never into the file this writes.
	req.Header.Set("Authorization", "Bearer "+k.NodeID+":"+k.NodeSecret)
	c := k.Client
	if c == nil {
		c = &http.Client{Timeout: 20 * time.Second}
	}
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if res.StatusCode != http.StatusOK {
		// The hub's refusals are distinct on purpose (403 for a station on another node,
		// 409 for one with no occupant), so the status travels rather than "mint failed".
		return fmt.Errorf("hub answered %d", res.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &out); err != nil || strings.TrimSpace(out.Token) == "" {
		return fmt.Errorf("hub returned no token")
	}
	return writeToken(w.Path, out.Token)
}

// writeToken replaces the file atomically, at 0600.
//
// Temp file plus rename, in the SAME directory, for the reason the installer gives about a
// binary: a reader must never see half a credential. A partial token would be refused by
// the far end and read, to whoever is looking, as a permission problem.
func writeToken(path, token string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".token-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(token + "\n"); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
