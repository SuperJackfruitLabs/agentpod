package stationtoken

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Source hands out a current station token per station, from memory.
//
// The file Keeper exists for a client that reads a path; this is for a caller inside the node —
// the loopback MCP proxy (internal/mcpproxy) — that needs a token per request and must never
// write one anywhere. Same exchange, same refresh floor: a token is reused while it has at least
// `refreshFloor` left and replaced before that, so a request forwarded with it has minutes of
// validity whatever the session's length. Concurrent callers for one station share one mint
// (single flight); stations never share an entry.
type Source struct {
	Hub        string
	NodeID     string
	NodeSecret string
	Client     *http.Client
	// Now is the clock; nil means time.Now. A seam so a long session is simulated, not waited out.
	Now func() time.Time

	// mint is the exchange; nil means the hub's. A test seam.
	mint func(ctx context.Context, stationID string) (string, error)

	mu      sync.Mutex
	entries map[string]*sourceEntry
}

type sourceEntry struct {
	token string
	exp   time.Time
	// inflight is non-nil while a mint for this station is running; it closes when it ends.
	inflight chan struct{}
	err      error
}

func (s *Source) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Token returns a token for stationID with at least `refreshFloor` of life left, minting one
// when the cached token is missing or too close to expiry. A failure is returned, never cached.
func (s *Source) Token(ctx context.Context, stationID string) (string, error) {
	for {
		s.mu.Lock()
		if s.entries == nil {
			s.entries = map[string]*sourceEntry{}
		}
		e := s.entries[stationID]
		if e == nil {
			e = &sourceEntry{}
			s.entries[stationID] = e
		}
		if e.token != "" && e.exp.Sub(s.now()) >= refreshFloor {
			tok := e.token
			s.mu.Unlock()
			return tok, nil
		}
		if wait := e.inflight; wait != nil {
			s.mu.Unlock()
			select {
			case <-wait:
			case <-ctx.Done():
				return "", ctx.Err()
			}
			s.mu.Lock()
			err := e.err
			s.mu.Unlock()
			if err != nil {
				return "", err
			}
			continue // re-read the entry the flight just filled
		}
		done := make(chan struct{})
		e.inflight, e.err = done, nil
		s.mu.Unlock()

		tok, err := s.doMint(ctx, stationID)
		var exp time.Time
		if err == nil {
			var ok bool
			if exp, ok = expiryOf(tok); !ok {
				err = fmt.Errorf("hub returned a token with no readable expiry")
			}
		}

		s.mu.Lock()
		if err == nil {
			e.token, e.exp = tok, exp
		}
		e.err, e.inflight = err, nil
		close(done)
		s.mu.Unlock()
		if err != nil {
			return "", err
		}
		return tok, nil
	}
}

func (s *Source) doMint(ctx context.Context, stationID string) (string, error) {
	if s.mint != nil {
		return s.mint(ctx, stationID)
	}
	return mint(ctx, s.Client, s.Hub, s.NodeID, s.NodeSecret, stationID)
}
