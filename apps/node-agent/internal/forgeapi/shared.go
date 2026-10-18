package forgeapi

// The shared base policy: an operator-authored file of services every station needs. The node
// COPIES its entries into each station's own policy file (each station has its own stk, see
// instances.go) when the instance is created and on every policy write, and marks the copies so
// they can be refreshed or removed later. The hub never edits them.
//
// When the operator removes a service from the shared file its copy leaves every station's policy
// and its credential is forgotten (stk `revoke`) BEFORE the policy file changes, since stk resolves
// a service through the policy (see Service.forgetDropped and StationInstances.maybeRefreshShared).
//
// What this does NOT do: deliver credentials. A shared service's credential is not the hub's to
// send and the node invents no path for it; whoever runs the station's stk loads it (for example
// `stk connect` against the instance), or the service is one that needs none.

import (
	"errors"
	"fmt"
	"strings"

	"go.yaml.in/yaml/v3"
)

// SharedGrantPrefix starts the `grant` label of every copied shared entry. stk accepts exactly
// three label keys, so the marker has to live in a value; a hub grant id never starts with it
// (entries refuse such a grant).
const SharedGrantPrefix = "shared:"

// ErrBadSharedPolicy: the shared file cannot be used; nothing is copied from it.
var ErrBadSharedPolicy = errors.New("shared base policy cannot be used")

func isSharedValue(v *yaml.Node) bool {
	return strings.HasPrefix(labelOf(v, MarkerLabel), SharedGrantPrefix)
}

// SharedServices lists the shared entries a policy file carries, in file order.
func SharedServices(existing []byte) []string {
	_, services, err := loadDoc(existing, false)
	if err != nil || services == nil {
		return nil
	}
	var out []string
	for i := 0; i+1 < len(services.Content); i += 2 {
		if isSharedValue(services.Content[i+1]) {
			out = append(out, services.Content[i].Value)
		}
	}
	return out
}

func deepCopy(n *yaml.Node) *yaml.Node {
	c := *n
	c.Content = nil
	for _, ch := range n.Content {
		c.Content = append(c.Content, deepCopy(ch))
	}
	return &c
}

// ApplyShared returns existing with its shared entries brought in line with the shared file: an
// entry in the shared file is added or replaced (in place), a marked entry no longer in it is
// removed. Nothing the node or the operator wrote for the station is changed, replaced or dropped:
// a shared entry whose service name, host or environment variable is already taken by one of the
// station's own entries is skipped (the station's own wins) and reported in skipped. A nil or
// empty shared means "no shared entries".
func ApplyShared(existing, shared []byte, station string) (out []byte, skipped []string, err error) {
	doc, services, err := loadDoc(existing, true)
	if err != nil {
		return nil, nil, err
	}
	_, sharedServices, err := loadDoc(shared, false)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrBadSharedPolicy, err)
	}

	type item struct {
		name string
		val  *yaml.Node
	}
	var want []item
	if sharedServices != nil {
		for i := 0; i+1 < len(sharedServices.Content); i += 2 {
			name, val := sharedServices.Content[i].Value, sharedServices.Content[i+1]
			if !serviceNameRE.MatchString(name) || strings.Contains(name, ".scope-") {
				return nil, nil, fmt.Errorf("%w: %q is not a valid service name", ErrBadSharedPolicy, name)
			}
			if val.Kind != yaml.MappingNode {
				return nil, nil, fmt.Errorf("%w: service %q is not a mapping", ErrBadSharedPolicy, name)
			}
			want = append(want, item{name, val})
		}
	}

	// What the station's own entries occupy.
	ownNames, ownHosts, ownEnv := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for i := 0; i+1 < len(services.Content); i += 2 {
		val := services.Content[i+1]
		if isSharedValue(val) {
			continue
		}
		ownNames[services.Content[i].Value] = true
		if h := scalarOf(val, "host"); h != "" {
			ownHosts[strings.ToLower(h)] = true
		}
		if v := scalarOf(val, "env_var"); v != "" {
			ownEnv[v] = true
		}
	}

	copies := map[string]*yaml.Node{}
	var order []string
	for _, w := range want {
		h, ev := strings.ToLower(scalarOf(w.val, "host")), scalarOf(w.val, "env_var")
		switch {
		case ownNames[w.name]:
			skipped = append(skipped, w.name+": the station has its own service of that name")
			continue
		case h != "" && ownHosts[h]:
			skipped = append(skipped, w.name+": the station already brokers host "+h)
			continue
		case ev != "" && ownEnv[ev]:
			skipped = append(skipped, w.name+": the station already uses environment variable "+ev)
			continue
		case copies[w.name] != nil:
			skipped = append(skipped, w.name+": named twice in the shared file")
			continue
		}
		c := deepCopy(w.val)
		var ls yaml.Node
		if err := ls.Encode(map[string]string{"station": station, "grant": SharedGrantPrefix + w.name}); err != nil {
			return nil, nil, err
		}
		// Keep an operator's other label keys (stk allows `principal`); the marker is ours.
		if old := mapGet(c, "labels"); old != nil && old.Kind == yaml.MappingNode {
			for i := 0; i+1 < len(old.Content); i += 2 {
				if k := old.Content[i].Value; k != "station" && k != MarkerLabel {
					ls.Content = append(ls.Content, deepCopy(old.Content[i]), deepCopy(old.Content[i+1]))
				}
			}
		}
		setKey(c, "labels", &ls)
		copies[w.name] = c
		order = append(order, w.name)
	}

	if len(copies) == 0 && len(SharedServices(existing)) == 0 {
		return existing, skipped, nil // nothing to add, nothing of ours to remove: the file is not rewritten
	}

	// In place: replace what is there, drop marked entries that are no longer wanted, append new.
	kept := services.Content[:0:0]
	placed := map[string]bool{}
	for i := 0; i+1 < len(services.Content); i += 2 {
		key, val := services.Content[i], services.Content[i+1]
		if !isSharedValue(val) {
			kept = append(kept, key, val)
			continue
		}
		if c, ok := copies[key.Value]; ok && !placed[key.Value] {
			kept = append(kept, key, c)
			placed[key.Value] = true
		}
	}
	for _, name := range order {
		if placed[name] {
			continue
		}
		kept = append(kept, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name,
			HeadComment: "managed by agentpod-node (shared base policy); do not edit"}, copies[name])
	}
	services.Content = kept
	b, err := encodeDoc(doc)
	if err != nil {
		return nil, nil, err
	}
	return b, skipped, nil
}
