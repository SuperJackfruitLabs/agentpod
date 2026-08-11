package acpproxy

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/coder/websocket"
)

// ProxyURL derives the ACP proxy WebSocket URL from the hub's HTTP(S) URL.
//
//	https://hub → wss://hub/api/acp/proxy?station=…
//	http://hub  → ws://hub/api/acp/proxy?station=…
//
// Mirrors gateway.wsURL rather than inventing a second scheme rule, so the two
// cannot drift.
func ProxyURL(hub, station, session string) string {
	base := strings.Replace(strings.Replace(hub, "http://", "ws://", 1), "https://", "wss://", 1)
	base = strings.TrimSuffix(base, "/")

	q := url.Values{}
	if station != "" {
		q.Set("station", station)
	}
	if session != "" {
		q.Set("session", session)
	}
	return base + "/api/acp/proxy?" + q.Encode()
}

// ValidateTarget rejects an invocation that does not say what to attach to.
//
// Guessing which station an editor meant is worse than refusing: the wrong
// guess starts an agent on the wrong machine, in someone's real workspace.
func ValidateTarget(station, session string) error {
	if station == "" && session == "" {
		return errors.New("one of --station or --session is required")
	}
	return nil
}

// Conn is the subset of a WebSocket the pipe needs.
type Conn interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Write(ctx context.Context, typ websocket.MessageType, p []byte) error
	Close(code websocket.StatusCode, reason string) error
}

// Dial opens the proxy socket.
//
// The token goes in the Authorization header, not the query string: a query
// parameter lands in proxy logs and shell history. The hub accepts `?token=`
// too — a browser cannot set headers on an upgrade — but nothing here is a
// browser, so the header is used.
func Dial(ctx context.Context, hub, token, station, session string) (*websocket.Conn, error) {
	if err := ValidateTarget(station, session); err != nil {
		return nil, err
	}
	if token == "" {
		return nil, errors.New("no hub token: set AGENTPOD_TOKEN or pass --token")
	}

	c, resp, err := websocket.Dial(ctx, ProxyURL(hub, station, session), &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer " + token}},
	})
	if err != nil {
		if resp != nil {
			switch resp.StatusCode {
			case 401:
				return nil, errors.New("hub rejected the token (401) — it may have expired")
			case 404:
				return nil, fmt.Errorf("station %q not found, or it belongs to another account (404)", station)
			}
			return nil, fmt.Errorf("hub returned %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("could not reach the hub: %w", err)
	}
	// ACP frames are small; the default read limit is not.
	c.SetReadLimit(readLimitBytes)
	return c, nil
}

// readLimitBytes caps a single inbound frame. Generous for ACP — a large tool
// result is still far below it — and finite so a broken peer cannot exhaust
// memory on someone's laptop.
const readLimitBytes = 32 << 20 // 32 MiB
