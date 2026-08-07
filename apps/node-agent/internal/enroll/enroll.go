package enroll

import ("bytes"; "encoding/json"; "fmt"; "net/http"
  "github.com/rakeshgangwar/agentpod/node-agent/internal/host")

type req struct { Token string `json:"token"`; HostInfo host.HostInfo `json:"hostInfo"` }
type resp struct { NodeID string `json:"nodeId"`; NodeSecret string `json:"nodeSecret"`; Error string `json:"error"` }

func Enroll(hubURL, token string, hi host.HostInfo) (string, string, error) {
  body, _ := json.Marshal(req{Token: token, HostInfo: hi})
  r, err := http.Post(hubURL+"/public/nodes/enroll", "application/json", bytes.NewReader(body))
  if err != nil { return "", "", err }
  defer r.Body.Close()
  var out resp
  if err := json.NewDecoder(r.Body).Decode(&out); err != nil { return "", "", err }
  if r.StatusCode != 200 { return "", "", fmt.Errorf("enroll failed: %s", out.Error) }
  return out.NodeID, out.NodeSecret, nil
}

// CheckCredential asks the hub whether nodeID:nodeSecret is still a valid
// identity there. (true, nil) on 200; (false, nil) on 401/403; error on
// anything else (network failure, 5xx) so callers can distinguish "hub said
// no" from "could not ask" — the latter must never destroy a stored identity.
func CheckCredential(hubURL, nodeID, nodeSecret string) (bool, error) {
  req, err := http.NewRequest("GET", hubURL+"/public/nodes/credential-check", nil)
  if err != nil { return false, err }
  req.Header.Set("Authorization", "Bearer "+nodeID+":"+nodeSecret)
  r, err := http.DefaultClient.Do(req)
  if err != nil { return false, err }
  defer r.Body.Close()
  switch r.StatusCode {
  case 200: return true, nil
  case 401, 403: return false, nil
  default: return false, fmt.Errorf("credential-check: unexpected status %d", r.StatusCode)
  }
}
