// Package benchbridge owns the proposed dedicated coordinator's authenticated
// Hub crossing. It does not grant authority or enable an installed capability.
package benchbridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
)

var ErrCurrent = errors.New("checkpoint current authority unavailable; retain attempt")

// ErrStale is an authenticated, well-formed hub decision that this attempt is
// stale_owner. It wraps ErrCurrent; only it (never a transport failure) lets a
// registered attempt clean up its own record.
var ErrStale = fmt.Errorf("checkpoint attempt superseded: %w", ErrCurrent)

// HubCurrent contains the existing enrollment credential privately. It must
// never enter a task environment, public DTO, source plan or error message.
type HubCurrent struct {
	endpoint      string
	nodeID        string
	authorization string
	client        *http.Client
}

// NewHubCurrent accepts only installation-owned enrollment configuration, never
// a broker request URL. TLS is required except for explicit loopback fixtures.
func NewHubCurrent(hub, nodeID, nodeSecret string) (*HubCurrent, error) {
	u, err := url.Parse(hub)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery ||
		u.Fragment != "" || u.Opaque != "" || u.Path != "" && u.Path != "/" ||
		nodeSecret == "" || len(nodeSecret) > 4096 || strings.ContainsAny(nodeSecret, "\r\n") {
		return nil, ErrCurrent
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback) {
		return nil, ErrCurrent
	}
	// The node ID is a path segment and an Authorization component, not a URL.
	if len(nodeID) == 0 || len(nodeID) > 200 {
		return nil, ErrCurrent
	}
	for _, r := range nodeID {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' {
			return nil, ErrCurrent
		}
	}
	transport := &http.Transport{Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		DialContext:         (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
		TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 3 * time.Second, MaxResponseHeaderBytes: 16 << 10}
	return &HubCurrent{endpoint: strings.TrimRight(u.String(), "/") + "/api/nodes/" + nodeID + "/bench-coordinator/current",
		nodeID:        nodeID,
		authorization: "Bearer " + nodeID + ":" + nodeSecret,
		client: &http.Client{Transport: transport, Timeout: 5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *HubCurrent) Close() { c.client.CloseIdleConnections() }

// Check sends once and requires a fresh reply to this exact random nonce and
// request. A valid refusal, cancellation, timeout or lost reply never grants
// permission, stops another owner, or proves that any process was fenced.
func (c *HubCurrent) Check(ctx context.Context, request benchcoordinatorwire.CurrentRequest) error {
	var nonce [16]byte
	if c == nil || c.client == nil || request.Identity.NodeID != c.nodeID {
		return ErrCurrent
	}
	if _, err := rand.Read(nonce[:]); err != nil {
		return ErrCurrent
	}
	request.Version = benchcoordinatorwire.CurrentVersion
	request.Nonce = hex.EncodeToString(nonce[:])
	raw, err := json.Marshal(request)
	if err != nil {
		return ErrCurrent
	}
	if _, err = benchcoordinatorwire.ParseCurrentRequest(raw); err != nil {
		return ErrCurrent
	}
	call, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(raw))
	if err != nil {
		return ErrCurrent
	}
	call.Header.Set("Authorization", c.authorization)
	call.Header.Set("Content-Type", "application/json")
	call.Header.Set("Accept", "application/json")
	call.Header.Set("Accept-Encoding", "identity")
	response, err := c.client.Do(call)
	if err != nil {
		return ErrCurrent
	}
	defer response.Body.Close()
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || response.StatusCode != http.StatusOK ||
		response.ContentLength > 4096 || response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity" {
		return ErrCurrent
	}
	noStore := false
	for _, directive := range strings.Split(response.Header.Get("Cache-Control"), ",") {
		noStore = noStore || strings.EqualFold(strings.TrimSpace(directive), "no-store")
	}
	if !noStore {
		return ErrCurrent
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(body) > 4096 {
		return ErrCurrent
	}
	decision, err := benchcoordinatorwire.ParseCurrentResponse(body, raw, time.Now().UnixMilli())
	if err == nil && decision.Decision == "refused" && decision.Code == "stale_owner" {
		return ErrStale
	}
	if err != nil || decision.Decision != "current" {
		return ErrCurrent
	}
	return nil
}
