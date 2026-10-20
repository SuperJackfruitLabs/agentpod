package mcpproxy

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestManagedResponsePreservesOrdinaryProtocolMetadata(t *testing.T) {
	response := &http.Response{Header: http.Header{"Mcp-Protocol-Version": {"2025-11-25"}, "Mcp-Session-Id": {"ordinary-session5"}}, Body: io.NopCloser(strings.NewReader("{}"))}
	if err := sanitizeManagedResponse(response, []string{"5-private-credential"}); err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Mcp-Protocol-Version") != "2025-11-25" || response.Header.Get("Mcp-Session-Id") != "ordinary-session5" {
		t.Fatal("a partial prefix corrupted ordinary response metadata")
	}
}

// Single-byte reads force every possible credential boundary through the streaming guard.
type oneByteReader struct{ io.Reader }

func (r oneByteReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return r.Reader.Read(p)
}
func TestCredentialGuardHandlesOverlappingPrefixesAndInterruptedResponse(t *testing.T) {
	for _, source := range []string{"safe ababcab then abcabd tail\n", "ababcababcabd\n"} {
		reader := newCredentialReader(oneByteReader{strings.NewReader(source)}, []string{"ababcab", "abcabd"})
		var output bytes.Buffer
		if _, err := io.Copy(&output, reader); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(output.String(), "ababcab") || strings.Contains(output.String(), "abcabd") || !strings.Contains(output.String(), "[redacted]") {
			t.Fatal("a credential crossed the response chunk boundary")
		}
	}
	reader := newCredentialReader(oneByteReader{strings.NewReader("safe abcab")}, []string{"abcabd"})
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "safe [redacted]" {
		t.Fatal("interrupted credential prefix escaped")
	}
}

func TestManagedProxyDoesNotEchoInjectedStationCredentials(t *testing.T) {
	const org = "org_00000000000000000001"
	const actor = "prn_00000000000000000001"
	token := identityToken(actor, org)
	variants := []string{token, base64.StdEncoding.EncodeToString([]byte(token)), base64.RawURLEncoding.EncodeToString([]byte(token))}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("upstream did not receive its credential")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Unreviewed", token)
		w.Header().Set("Mcp-Session-Id", token)
		w.Header().Set("Set-Cookie", "credential="+token)
		w.Header().Set("Trailer", "X-Unsafe-Trailer")
		w.WriteHeader(200)
		text := `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"` + strings.Join(variants, " ") + `"}]}}`
		for _, b := range []byte(text) {
			_, _ = w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
		w.Header().Set("X-Unsafe-Trailer", token)
	}))
	defer up.Close()
	p, err := Start(Config{Stations: []string{"s"}, HubURL: up.URL, Tokens: &fakeTokens{next: func(string) (string, error) { return token, nil }}})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	a, err := p.BindIdentity("s", Identity{BindingDigest: strings.Repeat("a", 64), OrganizationID: org, PrincipalID: actor, OccupancyEpoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	res := post(t, a[0].URL, secretOf(a[0]), nil)
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	public := fmt.Sprint(res.Header, res.Trailer) + string(data)
	for _, v := range variants {
		if strings.Contains(public, v) {
			t.Fatal("managed upstream echoed an injected credential")
		}
	}
	if !strings.Contains(string(data), "[redacted]") {
		t.Fatal("credential echoes were not replaced")
	}
	if res.Header.Get("X-Unreviewed") != "" || res.Header.Get("Set-Cookie") != "" || len(res.Trailer) != 0 {
		t.Fatal("unreviewed response metadata escaped")
	}
}

func TestManagedProxyStreamsSafeSSEWithoutWaitingForUpstreamEOF(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(release) }) }
	defer finish()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"progress\":1}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer up.Close()
	token := identityToken("prn_00000000000000000001", "org_00000000000000000001")
	p, err := Start(Config{Stations: []string{"s"}, HubURL: up.URL, Tokens: &fakeTokens{next: func(string) (string, error) { return token, nil }}})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	a, err := p.BindIdentity("s", Identity{BindingDigest: strings.Repeat("a", 64), OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000001", OccupancyEpoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	res := post(t, a[0].URL, secretOf(a[0]), nil)
	done := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(res.Body).ReadString('\n'); done <- line }()
	select {
	case line := <-done:
		if line != "data: {\"progress\":1}\n" {
			t.Fatalf("bad SSE event: %q", line)
		}
	case <-time.After(2 * time.Second):
		finish()
		t.Fatal("safe SSE waited for EOF")
	}
	finish()
}

func TestManagedProxyRejectsOpaqueCompressedResponse(t *testing.T) {
	token := identityToken("prn_00000000000000000001", "org_00000000000000000001")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.Write([]byte("opaque-fixture"))
	}))
	defer up.Close()
	p, err := Start(Config{Stations: []string{"s"}, HubURL: up.URL, Tokens: &fakeTokens{next: func(string) (string, error) { return token, nil }}})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	a, err := p.BindIdentity("s", Identity{BindingDigest: strings.Repeat("a", 64), OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000001", OccupancyEpoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	res := post(t, a[0].URL, secretOf(a[0]), nil)
	if res.StatusCode != 502 {
		t.Fatal("opaque compressed body bypassed managed redaction")
	}
}

func TestManagedProxyDoesNotLogCredentialsFromMalformedUpstreamTrailers(t *testing.T) {
	token := identityToken("prn_00000000000000000001", "org_00000000000000000001")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\nbad header %s\r\n\r\n", token)
	}))
	defer up.Close()
	logs := &logSink{}
	p, err := Start(Config{Stations: []string{"s"}, HubURL: up.URL, Logf: logs.Logf, Tokens: &fakeTokens{next: func(string) (string, error) { return token, nil }}})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	a, err := p.BindIdentity("s", Identity{BindingDigest: strings.Repeat("a", 64), OrganizationID: "org_00000000000000000001", PrincipalID: "prn_00000000000000000001", OccupancyEpoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	res := post(t, a[0].URL, secretOf(a[0]), nil)
	_, _ = io.ReadAll(res.Body)
	if strings.Contains(logs.String(), token) || !strings.Contains(logs.String(), "response incomplete") {
		t.Fatal("upstream response failure did not retain a safe diagnostic")
	}
}
