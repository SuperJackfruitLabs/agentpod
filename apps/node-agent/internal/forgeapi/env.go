package forgeapi

// What a station's harness is given so that its forge traffic goes through the station's own stk.
//
// The environment is stk's own (`stk env --json`, asked of THE STATION'S INSTANCE): the proxy URL
// with the proxy credential in it, the CA bundle variables, and a placeholder
// (`stk:ref:<service>:v1`) in each service's variable. No service secret is ever in it.
//
// The node never sets or changes NO_PROXY / no_proxy: a value there that covers a forge host sends
// that host's traffic around the broker, and a harness that bypasses the proxy silently defeats
// it. When one is already there the node cannot fix it, so it says so, loudly, once.

import (
	"context"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// proxyVars are the variables stk sets that are not placeholders: where the proxy is and which CA
// signs what it presents.
var proxyVars = map[string]bool{
	"HTTPS_PROXY": true, "https_proxy": true, "HTTP_PROXY": true, "http_proxy": true,
	"SSL_CERT_FILE": true, "CURL_CA_BUNDLE": true, "REQUESTS_CA_BUNDLE": true, "NODE_EXTRA_CA_CERTS": true,
	"NODE_USE_ENV_PROXY": true, "STK_BROKERED": true,
}

var proxyURLVars = []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"}
var caVars = []string{"SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"}

// placeholderRE is the only shape a non-proxy variable may have: stk's reference to a service,
// never the service's credential.
var placeholderRE = regexp.MustCompile(`^stk:ref:[A-Za-z0-9._-]+:v1$`)

func isNoProxy(name string) bool { return name == "NO_PROXY" || name == "no_proxy" }

// BrokerEnv returns the environment that routes a harness through the stk client c's instance:
// stk's proxy and CA variables plus the placeholder variable of each of its services. It carries
// nothing else: a NO_PROXY is dropped, and so is any variable whose value is not a placeholder, so
// a real secret cannot ride along whatever stk (or a poisoned policy) reports. It is empty, and
// not an error, when the instance has no service at all.
//
// The caller passes the client of THE STATION'S OWN instance; the station id is checked and used
// in errors only. The returned map holds the proxy credential: it goes into the harness
// environment and nowhere else.
func BrokerEnv(ctx context.Context, c stkclient.Client, stationID string) (map[string]string, error) {
	if err := checkStationID(stationID); err != nil {
		return nil, err
	}
	if c == nil {
		return nil, codedf("broker-env-failed", "no stk client for this station")
	}
	e, err := c.Env(ctx)
	if err != nil {
		return nil, coded("broker-env-failed", err)
	}
	out := map[string]string{}
	placeholders := 0
	for k, v := range e.Vars {
		switch {
		case isNoProxy(k):
			// never passed on
		case proxyVars[k]:
			out[k] = v
		case placeholderRE.MatchString(v) && validEnvName(k):
			out[k] = v
			placeholders++
		default:
			logf("forgeapi: stk reported variable %s for station %s that is not a placeholder; it was not passed on", clean(k), clean(stationID))
		}
	}
	if placeholders == 0 {
		return map[string]string{}, nil
	}
	// stk's own fields are the source of truth for where the proxy and the CA are.
	for _, k := range proxyURLVars {
		if out[k] == "" && e.ProxyURL != "" {
			out[k] = e.ProxyURL
		}
	}
	for _, k := range caVars {
		if out[k] == "" && e.CAPath != "" {
			out[k] = e.CAPath
		}
	}
	return out, nil
}

var envNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func validEnvName(k string) bool { return envNameRE.MatchString(k) }

// EnvList renders a map as KEY=VALUE entries, sorted, for a process environment.
func EnvList(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+m[k])
	}
	return out
}

// WithBrokerEnv adds the station's broker environment to env. The result is appended to
// os.Environ() by the spawner, where the LAST duplicate wins, so a name env already sets is left
// to env (the descriptor knows things this package does not) and a name it does not set is added.
// With nothing to add, env is returned as it came. NO_PROXY and no_proxy are never added.
//
// forgeHosts are the hosts the station's grants reach. A NO_PROXY in env, or in the node's own
// environment (which the harness inherits), that covers one of them (or is "*") is warned about
// once: the node does not rewrite it, but a harness that bypasses the proxy defeats the broker.
func WithBrokerEnv(env []string, add map[string]string, forgeHosts ...string) []string {
	if len(add) == 0 {
		return env
	}
	set := make(map[string]bool, len(env))
	for _, e := range env {
		set[strings.SplitN(e, "=", 2)[0]] = true
	}
	keys := make([]string, 0, len(add))
	for k := range add {
		if !isNoProxy(k) && !set[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	out := append(make([]string, 0, len(env)+len(keys)), env...)
	for _, k := range keys {
		out = append(out, k+"="+add[k])
	}
	warnNoProxy(env, forgeHosts)
	return out
}

// lookupProcessEnv reads the node's own environment (a test seam).
var lookupProcessEnv = os.Getenv

var (
	noProxyMu     sync.Mutex
	noProxyWarned = map[string]bool{}
)

func resetNoProxyWarned() {
	noProxyMu.Lock()
	noProxyWarned = map[string]bool{}
	noProxyMu.Unlock()
}

func warnNoProxy(env []string, hosts []string) {
	var values []string
	for _, e := range env {
		if k, v, _ := strings.Cut(e, "="); isNoProxy(k) && v != "" {
			values = append(values, v)
		}
	}
	for _, k := range []string{"NO_PROXY", "no_proxy"} {
		if v := lookupProcessEnv(k); v != "" {
			values = append(values, v)
		}
	}
	for _, v := range values {
		covered := ""
		if noProxyCovers(v, "") { // "*" covers everything
			covered = "every host"
		}
		for _, h := range hosts {
			if covered == "" && noProxyCovers(v, h) {
				covered = h
			}
		}
		if covered == "" {
			continue
		}
		id := v + "|" + covered
		noProxyMu.Lock()
		seen := noProxyWarned[id]
		noProxyWarned[id] = true
		noProxyMu.Unlock()
		if !seen {
			logf("forgeapi: WARNING: NO_PROXY=%q covers %s, so a harness started with it reaches the forge directly and bypasses the stk broker; the node does not change NO_PROXY, remove it from the harness environment", clean(v), clean(covered))
		}
	}
}

// noProxyCovers reports whether a NO_PROXY list names host (or everything, with "*"). An empty
// host asks only about "*".
func noProxyCovers(list, host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	for _, tok := range strings.Split(list, ",") {
		tok = strings.ToLower(strings.TrimSpace(tok))
		if tok == "" {
			continue
		}
		if tok == "*" {
			return true
		}
		if host == "" {
			continue
		}
		if i := strings.LastIndex(tok, ":"); i >= 0 && !strings.Contains(tok[i:], "]") {
			tok = tok[:i]
		}
		tok = strings.TrimPrefix(strings.TrimPrefix(tok, "*"), ".")
		if tok != "" && (host == tok || strings.HasSuffix(host, "."+tok)) {
			return true
		}
	}
	return false
}

// CommandFunc is the shape of `descriptor.Handler.ACPCommand`: the argv, working directory and
// extra environment a station's harness is started with (the same shape as gitidentity's).
type CommandFunc func(key string) (argv []string, dir string, env []string, err error)

// WithBrokerCommand gives a station's harness its own broker environment, the way
// gitidentity.WithSSHCommand gives it its push key: lookup(key) returns the station's environment
// (nil for a station with no grants, which is then left exactly as it was) and the forge hosts it
// reaches. The descriptor stays free of this package.
func WithBrokerCommand(inner CommandFunc, lookup func(key string) (map[string]string, []string)) CommandFunc {
	return func(key string) ([]string, string, []string, error) {
		argv, dir, env, err := inner(key)
		if err != nil {
			return argv, dir, env, err
		}
		add, hosts := lookup(key)
		return argv, dir, WithBrokerEnv(env, add, hosts...), nil
	}
}
