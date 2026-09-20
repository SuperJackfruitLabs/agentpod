package gateway

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// SkillArtifactRequest identifies an authorization at the enrolled hub. Broker
// messages never choose the download origin or carry the node credential.
type SkillArtifactRequest struct {
	StationID     string
	StationKey    string
	OperationID   string
	ArchiveSHA256 string
}

type SkillArtifactFetcher func(context.Context, SkillArtifactRequest) ([]byte, error)

var artifactSegment = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,256}$`)
var artifactOperation = regexp.MustCompile(`^[a-f0-9]{32}$`)
var artifactDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

const maxSkillDownload = 32 << 20

// NewHTTPArtifactFetcher uses the existing node identity to redeem a specific
// operation. TLS is required except for loopback development hubs. Redirects
// are refused, and response bodies and transport errors are never logged.
func NewHTTPArtifactFetcher(hub, nodeID, nodeSecret string) (SkillArtifactFetcher, error) {
	origin, err := url.Parse(hub)
	if err != nil || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" || origin.Opaque != "" {
		return nil, fmt.Errorf("skills: invalid artifact hub origin")
	}
	ip := net.ParseIP(origin.Hostname())
	loopback := strings.EqualFold(origin.Hostname(), "localhost") || (ip != nil && ip.IsLoopback())
	if origin.Scheme != "https" && !(origin.Scheme == "http" && loopback) {
		return nil, fmt.Errorf("skills: artifact hub requires HTTPS or loopback HTTP")
	}
	if !artifactSegment.MatchString(nodeID) || nodeSecret == "" || strings.ContainsAny(nodeSecret, "\r\n") {
		return nil, fmt.Errorf("skills: invalid artifact node identity")
	}
	base := strings.TrimRight(origin.String(), "/")
	client := &http.Client{
		Timeout:       60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return func(ctx context.Context, request SkillArtifactRequest) ([]byte, error) {
		if !artifactSegment.MatchString(request.StationID) || !artifactOperation.MatchString(request.OperationID) || !artifactDigest.MatchString(request.ArchiveSHA256) || !validArtifactStationKey(request.StationKey) {
			return nil, fmt.Errorf("skills: invalid artifact request")
		}
		endpoint := base + "/api/nodes/" + nodeID + "/stations/" + request.StationID + "/skill-artifacts/" + request.OperationID
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
		if err != nil {
			return nil, fmt.Errorf("skills: could not build artifact request")
		}
		req.Header.Set("Authorization", "Bearer "+nodeID+":"+nodeSecret)
		req.Header.Set("X-AgentPod-Station-Key", request.StationKey)
		req.Header.Set("Accept", "application/octet-stream")
		res, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("skills: could not reach artifact hub")
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("skills: hub refused artifact download (status %d)", res.StatusCode)
		}
		if res.ContentLength > maxSkillDownload {
			return nil, fmt.Errorf("skills: artifact download exceeds limit")
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, maxSkillDownload+1))
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("skills: incomplete artifact download")
		}
		if len(data) > maxSkillDownload {
			return nil, fmt.Errorf("skills: artifact download exceeds limit")
		}
		if fmt.Sprintf("%x", sha256.Sum256(data)) != request.ArchiveSHA256 {
			return nil, fmt.Errorf("skills: downloaded artifact digest differs")
		}
		return data, nil
	}, nil
}

func validArtifactStationKey(key string) bool {
	if len(key) == 0 || len(key) > 512 || strings.TrimSpace(key) != key {
		return false
	}
	for _, char := range key {
		if char < 32 || char == 127 {
			return false
		}
	}
	return true
}
