package salaam

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func (c *Client) passiveRead(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://salaam"+path, nil)
	if err != nil {
		return err
	}
	res, err := c.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("salaam: private inventory unavailable")
	}
	d := json.NewDecoder(io.LimitReader(res.Body, 1<<20))
	if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("salaam: invalid bounded inventory response")
	}
	return nil
}

type contextInventory struct {
	Version      int     `json:"version"`
	Revision     int     `json:"revision"`
	Digest       *string `json:"digest"`
	State        string  `json:"state"`
	Loaded       *bool   `json:"loaded"`
	LoadedReason string  `json:"loaded_reason"`
	Bundles      []struct {
		Path           string `json:"path"`
		Digest         string `json:"digest"`
		ManifestSHA256 string `json:"manifest_sha256"`
	} `json:"bundles"`
	Entries []struct {
		Path         string `json:"path"`
		SHA256       string `json:"sha256"`
		Kind         string `json:"kind"`
		SkillID      string `json:"skill_id"`
		BundleDigest string `json:"bundle_digest"`
	} `json:"entries"`
}

// SkillInventory reports reviewed session admission and actual provider-payload
// evidence. It performs no discovery, file scanning, startup or execution.
func (c *Client) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	if !filepath.IsAbs(c.Workspace) || key != StationKey(c.Workspace) {
		return skills.Inventory{}, fmt.Errorf("salaam: inventory station differs from private workspace")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result := skills.Inventory{StationKey: key, Harness: "salaam", ObservedAt: now, Skills: []skills.Entry{}, Plugins: []skills.Plugin{}, Issues: []skills.Issue{}, Coverage: skills.Coverage{Complete: true, Roots: []skills.RootCoverage{}, Limitations: []string{"Only explicit session admissions are inventoried; unpublished files, builtin commands and skill exercise are not inferred."}}}
	var sessions []struct {
		ID  string `json:"id"`
		Cwd string `json:"cwd"`
	}
	if err := c.passiveRead(ctx, "/v1/sessions", &sessions); err != nil {
		return skills.Inventory{}, err
	}
	if len(sessions) > 64 {
		sessions = sessions[:64]
		result.Coverage.Complete = false
		result.Coverage.Limitations = append(result.Coverage.Limitations, "Session inventory truncated at 64 sessions")
	}
	entries := map[string]*skills.Entry{}
	observation := func(value *bool, reason string) skills.Observation {
		if len(reason) > 2048 {
			reason = reason[:2048]
		}
		var at *string
		if value != nil {
			at = &now
		}
		return skills.Observation{Value: value, ObservedAt: at, Reason: reason}
	}
	known := func(value bool, reason string) skills.Observation { return observation(&value, reason) }
	for _, session := range sessions {
		if session.Cwd != c.Workspace {
			result.Coverage.Complete = false
			continue
		}
		if session.ID == "" || len(session.ID) > 256 {
			return skills.Inventory{}, fmt.Errorf("salaam: invalid inventory session identity")
		}
		var inventory contextInventory
		if err := c.passiveRead(ctx, "/v1/sessions/"+url.PathEscape(session.ID)+"/context", &inventory); err != nil {
			result.Coverage.Complete = false
			result.Issues = append(result.Issues, skills.Issue{Path: session.ID, Reason: "Session admission could not be observed"})
			continue
		}
		if inventory.Version != 1 || (inventory.State != "empty" && inventory.State != "admitted" && inventory.State != "stale") || len(inventory.Entries) > 1024 {
			return skills.Inventory{}, fmt.Errorf("salaam: unknown context inventory version or state")
		}
		validDigest := regexp.MustCompile(`^[a-f0-9]{64}$`)
		if inventory.State != "empty" && (inventory.Revision < 1 || inventory.Digest == nil || !validDigest.MatchString(*inventory.Digest)) {
			return skills.Inventory{}, fmt.Errorf("salaam: context admission digest is missing")
		}
		bundles := map[string]string{}
		for _, bundle := range inventory.Bundles {
			if !validDigest.MatchString(bundle.Digest) || !validDigest.MatchString(bundle.ManifestSHA256) {
				return skills.Inventory{}, fmt.Errorf("salaam: invalid context bundle pin")
			}
			bundles[bundle.Path] = bundle.Digest
		}
		for _, entry := range inventory.Entries {
			if entry.Kind != "skill" {
				continue
			}
			if !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,127}$`).MatchString(entry.SkillID) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(entry.SHA256) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(entry.BundleDigest) || filepath.IsAbs(entry.Path) || filepath.Clean(entry.Path) != entry.Path || strings.HasPrefix(entry.Path, "../") || !strings.HasPrefix(entry.Path, ".salaam/skills/") {
				return skills.Inventory{}, fmt.Errorf("salaam: context skill identity is invalid")
			}
			bundlePath := filepath.ToSlash(filepath.Dir(filepath.Dir(filepath.Dir(entry.Path))))
			if bundles[bundlePath] != entry.BundleDigest || entry.Path != bundlePath+"/skills/"+entry.SkillID+"/SKILL.md" {
				return skills.Inventory{}, fmt.Errorf("salaam: skill entry is not bound to its inventoried bundle")
			}
			path := filepath.Join(c.Workspace, entry.Path)
			id := entry.BundleDigest + ":" + entry.SkillID + ":" + path + ":" + entry.SHA256
			reason := fmt.Sprintf("session %s context revision %d: %s; %s", session.ID, inventory.Revision, inventory.State, inventory.LoadedReason)
			loaded := inventory.Loaded
			if inventory.State != "admitted" {
				v := false
				loaded = &v
			}
			if previous, ok := entries[id]; ok {
				previousReason := previous.Evidence.Loaded.Reason
				if loaded != nil && *loaded {
					previous.Evidence.Loaded = known(true, reason)
				} else if previous.Evidence.Loaded.Value == nil || !*previous.Evidence.Loaded.Value {
					previous.Evidence.Loaded = observation(loaded, reason)
				}
				if inventory.State == "admitted" {
					previous.Evidence.Present = known(true, reason)
					previous.Evidence.Eligible = known(true, reason)
				}
				if len(previousReason)+len(reason) < 2000 {
					previous.Evidence.Loaded.Reason = previousReason + "; " + reason
				} else {
					previous.Evidence.Loaded.Reason = previousReason
				}
				continue
			}
			present := observation(nil, "Stale admission does not establish current file presence")
			if inventory.State == "admitted" {
				present = known(true, reason)
			}
			artifact, entrypoint := entry.BundleDigest, entry.SHA256
			locator := filepath.Dir(filepath.Dir(filepath.Dir(path)))
			if len(entries) >= 1024 {
				result.Coverage.Complete = false
				continue
			}
			opaqueID := fmt.Sprintf("salaam:%x", sha256.Sum256([]byte(id)))
			item := &skills.Entry{ID: opaqueID, Name: entry.SkillID, Description: "Explicitly reviewed Salaam skill admission", Path: path, Scope: "workspace", Source: skills.Source{Kind: "local", Locator: &locator, ArtifactDigest: &artifact}, EntrypointDigest: &entrypoint, Shadowing: skills.Shadowing{Status: "unknown", Candidates: []string{}}, Dependencies: skills.Dependencies{Known: false, Items: []skills.Dependency{}}, Compatibility: []skills.Compatibility{}, Evidence: skills.Evidence{Catalogued: observation(nil, "Catalog membership was not observed"), Present: present, Eligible: known(inventory.State == "admitted", reason), Loaded: observation(loaded, reason), Exercised: observation(nil, "Provider-payload admission does not prove skill exercise")}}
			if inventory.State == "admitted" {
				item.EffectivePath = &path
			}
			entries[id] = item
		}
	}
	if !result.Coverage.Complete {
		result.Coverage.Limitations = append(result.Coverage.Limitations, "Only sessions with the station's exact configured workspace and successful bounded reads are included")
	}
	ids := make([]string, 0, len(entries))
	for id := range entries {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		result.Skills = append(result.Skills, *entries[id])
	}
	if len(result.Skills) > 1024 {
		result.Skills = result.Skills[:1024]
		result.Coverage.Complete = false
	}
	return result, nil
}
