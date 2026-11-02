package fleetcli

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func RandomURLSafe(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

type LoginResult struct {
	Code  string
	State string
	Err   error
}

// Exchange trades the code and verifier for a token, from this process rather than the browser.
func Exchange(hub, code, verifier, redirectURI string) (string, error) {
	// No client id: the exchange identifies the client by which registered redirect URI the
	// code was issued for. Sending one anyway would be a field the endpoint ignores, which is
	// how a reader later concludes it matters.
	body, err := json.Marshal(map[string]string{
		"code":          code,
		"code_verifier": verifier,
		"redirect_uri":  redirectURI,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest("POST", hub+"/api/auth/token/exchange", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	// Deliberately no Origin header: the exchange refuses any request carrying one, because a
	// browser that can reach it is a browser that can spend somebody's code.
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach %s: %w", hub, err)
	}
	defer res.Body.Close()
	var out struct {
		Token            string `json:"token"`
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("the hub's answer was not JSON (%d)", res.StatusCode)
	}
	if res.StatusCode != 200 {
		if out.ErrorDescription != "" {
			return "", fmt.Errorf("the hub refused the exchange: %s", out.ErrorDescription)
		}
		return "", fmt.Errorf("the hub refused the exchange (%d): %s", res.StatusCode, out.Error)
	}
	token := out.Token
	if token == "" {
		token = out.AccessToken
	}
	if token == "" {
		return "", fmt.Errorf("the hub returned no token")
	}
	return token, nil
}
