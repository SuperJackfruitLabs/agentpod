package enroll

import ("encoding/json"; "net/http"; "net/http/httptest"; "testing"
  "github.com/rakeshgangwar/agentpod/node-agent/internal/host")

func TestEnrollPostsAndParses(t *testing.T) {
  srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    if r.URL.Path != "/public/nodes/enroll" { t.Fatalf("path %s", r.URL.Path) }
    json.NewEncoder(w).Encode(map[string]string{"nodeId": "node_9", "nodeSecret": "sek"})
  }))
  defer srv.Close()
  id, sec, err := Enroll(srv.URL, "tok", host.Info())
  if err != nil { t.Fatal(err) }
  if id != "node_9" || sec != "sek" { t.Fatalf("got %s/%s", id, sec) }
}

func TestCheckCredential(t *testing.T) {
  t.Run("200 means valid", func(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
      if r.URL.Path != "/public/nodes/credential-check" { t.Errorf("path = %s", r.URL.Path) }
      if got := r.Header.Get("Authorization"); got != "Bearer node_1:sec" { t.Errorf("auth = %s", got) }
      w.WriteHeader(200)
    }))
    defer srv.Close()
    valid, err := CheckCredential(srv.URL, "node_1", "sec")
    if err != nil { t.Fatal(err) }
    if !valid { t.Fatal("want valid") }
  })
  t.Run("401 means invalid, not an error", func(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
      w.WriteHeader(401)
    }))
    defer srv.Close()
    valid, err := CheckCredential(srv.URL, "node_1", "sec")
    if err != nil { t.Fatal(err) }
    if valid { t.Fatal("want invalid") }
  })
  t.Run("5xx is an error", func(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
      w.WriteHeader(500)
    }))
    defer srv.Close()
    if _, err := CheckCredential(srv.URL, "node_1", "sec"); err == nil { t.Fatal("want error") }
  })
  t.Run("unreachable hub is an error", func(t *testing.T) {
    if _, err := CheckCredential("http://127.0.0.1:1", "node_1", "sec"); err == nil { t.Fatal("want error") }
  })
}
