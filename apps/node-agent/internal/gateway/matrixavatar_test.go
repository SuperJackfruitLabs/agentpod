package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const avatarTestToken = "syt_avatar_secret_never_in_errors"

// A real PNG header: http.DetectContentType sniffs it as image/png.
var pngBytes = append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), bytes.Repeat([]byte{0}, 64)...)

type fakeHomeserver struct {
	uploads     int
	uploadType  string
	uploadBody  []byte
	avatarPath  string
	avatarURL   string
	auth        []string
	uploadCode  int
	profileCode int
}

func (f *fakeHomeserver) server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/_matrix/media/v3/upload":
			f.uploads++
			f.uploadType = r.Header.Get("Content-Type")
			f.uploadBody, _ = io.ReadAll(r.Body)
			if f.uploadCode != 0 {
				w.WriteHeader(f.uploadCode)
				_, _ = w.Write([]byte(`{"errcode":"M_TOO_LARGE","error":"too big"}`))
				return
			}
			_, _ = w.Write([]byte(`{"content_uri":"mxc://id.agentpod.dev/abc123"}`))
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.EscapedPath(), "/_matrix/client/v3/profile/"):
			f.avatarPath = r.URL.Path
			var body struct {
				AvatarURL string `json:"avatar_url"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.avatarURL = body.AvatarURL
			if f.profileCode != 0 {
				w.WriteHeader(f.profileCode)
				_, _ = w.Write([]byte(`{"errcode":"M_FORBIDDEN"}`))
				return
			}
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func avatarDeps(hs string, content []byte, truncated bool) MatrixAvatarDeps {
	return MatrixAvatarDeps{
		HarnessFor: func(string) (string, error) { return "hermes", nil },
		Resolver:   WorkspaceFunc(func(string) (string, error) { return "/root/.hermes/profiles/coder-kai", nil }),
		ReadFile: func(key, path string, maxBytes int64) ([]byte, bool, error) {
			return content, truncated, nil
		},
		Login: func(string) (MatrixLogin, error) {
			return MatrixLogin{Homeserver: hs, UserID: "@agent_coder-kai:id.agentpod.dev", AccessToken: avatarTestToken}, nil
		},
	}
}

const avatarParams = `{"key":"hermes:coder-kai","path":"pfp.png"}`

func TestMatrixAvatarPassesOtherVerbsThrough(t *testing.T) {
	h := NewMatrixAvatarHandler(matrixAdoptPassthrough(), avatarDeps("http://unused", pngBytes, false))
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil || got != "inner:health" {
		t.Fatalf("got %v, %v; want the inner handler's result", got, err)
	}
}

func TestMatrixAvatarUploadsAndSetsWithTheHarnessToken(t *testing.T) {
	hs := &fakeHomeserver{}
	srv := hs.server(t)
	h := NewMatrixAvatarHandler(matrixAdoptPassthrough(), avatarDeps(srv.URL, pngBytes, false))

	got, _, err := h.Handle(t.Context(), "matrix.avatar.set", json.RawMessage(avatarParams), nil)
	if err != nil {
		t.Fatal(err)
	}
	res := got.(matrixAvatarResult)
	if res.MatrixID != "@agent_coder-kai:id.agentpod.dev" || res.MXC != "mxc://id.agentpod.dev/abc123" {
		t.Fatalf("result = %+v", res)
	}
	if hs.uploads != 1 || hs.uploadType != "image/png" || !bytes.Equal(hs.uploadBody, pngBytes) {
		t.Fatalf("upload: n=%d type=%q len=%d", hs.uploads, hs.uploadType, len(hs.uploadBody))
	}
	if hs.avatarPath != "/_matrix/client/v3/profile/@agent_coder-kai:id.agentpod.dev/avatar_url" {
		t.Fatalf("avatar path = %q", hs.avatarPath)
	}
	if hs.avatarURL != "mxc://id.agentpod.dev/abc123" {
		t.Fatalf("avatar_url = %q", hs.avatarURL)
	}
	for _, a := range hs.auth {
		if a != "Bearer "+avatarTestToken {
			t.Fatalf("authorization = %q, want the harness's own token", a)
		}
	}
}

func TestMatrixAvatarRefusesWhatIsNotAnImage(t *testing.T) {
	hs := &fakeHomeserver{}
	srv := hs.server(t)
	h := NewMatrixAvatarHandler(matrixAdoptPassthrough(), avatarDeps(srv.URL, []byte("MATRIX_ACCESS_TOKEN=x\n"), false))
	_, _, err := h.Handle(t.Context(), "matrix.avatar.set", json.RawMessage(`{"key":"hermes:coder-kai","path":".env"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "not an image") {
		t.Fatalf("err = %v, want a not-an-image refusal", err)
	}
	if hs.uploads != 0 {
		t.Fatal("uploaded a non-image")
	}
}

func TestMatrixAvatarRefusesATruncatedImage(t *testing.T) {
	hs := &fakeHomeserver{}
	srv := hs.server(t)
	h := NewMatrixAvatarHandler(matrixAdoptPassthrough(), avatarDeps(srv.URL, pngBytes, true))
	_, _, err := h.Handle(t.Context(), "matrix.avatar.set", json.RawMessage(avatarParams), nil)
	if err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("err = %v, want a size refusal", err)
	}
	if hs.uploads != 0 {
		t.Fatal("uploaded a truncated image")
	}
}

func TestMatrixAvatarRefusesAHarnessWithNoMatrixLogin(t *testing.T) {
	deps := avatarDeps("http://unused", pngBytes, false)
	deps.HarnessFor = func(string) (string, error) { return "codex", nil }
	h := NewMatrixAvatarHandler(matrixAdoptPassthrough(), deps)
	_, _, err := h.Handle(t.Context(), "matrix.avatar.set", json.RawMessage(`{"key":"codex:x","path":"a.png"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "only hermes") {
		t.Fatalf("err = %v, want a harness refusal", err)
	}
}

func TestMatrixAvatarReportsAMissingLogin(t *testing.T) {
	deps := avatarDeps("http://unused", pngBytes, false)
	deps.Login = func(string) (MatrixLogin, error) { return MatrixLogin{}, errors.New("no login in .env") }
	h := NewMatrixAvatarHandler(matrixAdoptPassthrough(), deps)
	_, _, err := h.Handle(t.Context(), "matrix.avatar.set", json.RawMessage(avatarParams), nil)
	if err == nil || !strings.Contains(err.Error(), "no login in .env") {
		t.Fatalf("err = %v", err)
	}
}

func TestMatrixAvatarHomeserverRefusalsNeverCarryTheToken(t *testing.T) {
	for name, hs := range map[string]*fakeHomeserver{
		"upload":  {uploadCode: http.StatusRequestEntityTooLarge},
		"profile": {profileCode: http.StatusForbidden},
	} {
		t.Run(name, func(t *testing.T) {
			srv := hs.server(t)
			h := NewMatrixAvatarHandler(matrixAdoptPassthrough(), avatarDeps(srv.URL, pngBytes, false))
			_, _, err := h.Handle(t.Context(), "matrix.avatar.set", json.RawMessage(avatarParams), nil)
			if err == nil {
				t.Fatal("want an error")
			}
			if strings.Contains(err.Error(), avatarTestToken) {
				t.Fatalf("error leaks the token: %v", err)
			}
			if !strings.Contains(err.Error(), "M_") {
				t.Fatalf("error should name the homeserver's errcode: %v", err)
			}
		})
	}
}
