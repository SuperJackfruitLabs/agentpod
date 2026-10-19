package mcpproxy

import (
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// The proxy alone knows the injected station token. Sanitize here, before any response
// reaches the daemon. This covers exact credentials and common encodings, not arbitrary
// exfiltration by a malicious product. Product authorization remains the upstream's.
func credentialPatterns(secrets ...string) []string {
	seen := map[string]bool{}
	var out []string
	for _, secret := range secrets {
		for _, value := range []string{secret, url.QueryEscape(secret), url.PathEscape(secret),
			base64.StdEncoding.EncodeToString([]byte(secret)), base64.RawStdEncoding.EncodeToString([]byte(secret)),
			base64.URLEncoding.EncodeToString([]byte(secret)), base64.RawURLEncoding.EncodeToString([]byte(secret))} {
			if value != "" && !seen[value] {
				seen[value] = true
				out = append(out, value)
			}
		}
	}
	return out
}

type secretMatch struct {
	value    []byte
	fallback []int
	prefix   int
}
type credentialReader struct {
	source         io.Reader
	patterns       []secretMatch
	pending, ready []byte
	terminal       error
}

func newCredentialReader(source io.Reader, values []string) *credentialReader {
	r := &credentialReader{source: source}
	for _, value := range values {
		if value == "" {
			continue
		}
		p := secretMatch{value: []byte(value), fallback: make([]int, len(value))}
		for i, j := 1, 0; i < len(p.value); i++ {
			for j > 0 && p.value[i] != p.value[j] {
				j = p.fallback[j-1]
			}
			if p.value[i] == p.value[j] {
				j++
			}
			p.fallback[i] = j
		}
		r.patterns = append(r.patterns, p)
	}
	return r
}

// Independent KMP states retain only a possible credential prefix across reads. Safe SSE
// bytes flush immediately; neither an entire response nor a whole SSE event is buffered.
func (r *credentialReader) consume(data []byte) {
	for _, b := range data {
		r.pending = append(r.pending, b)
		longest, matched := 0, 0
		for i := range r.patterns {
			p := &r.patterns[i]
			for p.prefix > 0 && b != p.value[p.prefix] {
				p.prefix = p.fallback[p.prefix-1]
			}
			if b == p.value[p.prefix] {
				p.prefix++
			}
			if p.prefix == len(p.value) {
				if p.prefix > matched {
					matched = p.prefix
				}
			} else if p.prefix > longest {
				longest = p.prefix
			}
		}
		if matched > 0 {
			r.ready = append(r.ready, r.pending[:len(r.pending)-matched]...)
			r.ready = append(r.ready, "[redacted]"...)
			r.pending = r.pending[:0]
			for i := range r.patterns {
				r.patterns[i].prefix = 0
			}
		} else {
			safe := len(r.pending) - longest
			r.ready = append(r.ready, r.pending[:safe]...)
			copy(r.pending, r.pending[safe:])
			r.pending = r.pending[:longest]
		}
	}
}

func (r *credentialReader) Read(dst []byte) (int, error) {
	if len(dst) == 0 {
		return 0, nil
	}
	for len(r.ready) == 0 && r.terminal == nil {
		var buf [4096]byte
		n, err := r.source.Read(buf[:])
		r.consume(buf[:n])
		if err != nil {
			r.terminal = err
			// An interrupted response may end inside a secret. Do not release its prefix.
			if len(r.pending) > 0 {
				r.ready = append(r.ready, "[redacted]"...)
				r.pending = nil
			}
		} else if n == 0 {
			return 0, nil
		}
	}
	if len(r.ready) > 0 {
		n := copy(dst, r.ready)
		r.ready = r.ready[n:]
		return n, nil
	}
	return 0, r.terminal
}

type managedResponseBody struct {
	io.Reader
	upstream io.ReadCloser
	response *http.Response
}

// ReverseProxy also logs body-copy/trailer errors outside its ErrorHandler. Such errors
// can quote untrusted upstream bytes; retain the event without recording their contents.
type managedProxyDiagnostic func()

func (report managedProxyDiagnostic) Write(data []byte) (int, error) { report(); return len(data), nil }

func (b *managedResponseBody) Read(dst []byte) (int, error) {
	n, err := b.Reader.Read(dst)
	// net/http may populate trailers only while consuming the final body bytes.
	b.response.Trailer = nil
	return n, err
}
func (b *managedResponseBody) Close() error {
	err := b.upstream.Close()
	b.response.Trailer = nil
	return err
}

func sanitizeManagedResponse(response *http.Response, patterns []string) error {
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return fmt.Errorf("managed MCP response has unsupported content encoding")
	}
	safe := make(http.Header)
	for _, name := range []string{"Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"} {
		for _, value := range response.Header.Values(name) {
			// Header values are complete, bounded HTTP fields. Replace full credentials only:
			// treating an ordinary trailing character as a truncated body corrupts session IDs.
			for _, pattern := range patterns {
				value = strings.ReplaceAll(value, pattern, "[redacted]")
			}
			safe.Add(name, value)
		}
	}
	response.Header = safe
	response.ContentLength = -1
	response.Trailer = nil
	source := response.Body
	response.Body = &managedResponseBody{Reader: newCredentialReader(source, patterns), upstream: source, response: response}
	return nil
}
