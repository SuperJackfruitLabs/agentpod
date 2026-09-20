package skills

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

const (
	maxSkills          = 256
	maxEntrypointBytes = 128 << 10
	maxTotalBytes      = 8 << 20
	maxEntries         = 4096
	maxDepth           = 8
	maxIssues          = 256
)

// RootSpec comes from a descriptor, never a wire request.
type RootSpec struct{ RelativePath, Scope string }

var errLimit = errors.New("inventory scan limit reached")

type scanner struct {
	ctx                context.Context
	root               *os.Root
	workspace          string
	result             Inventory
	visited, bytesRead int
}

// Scan reports file observations in selected station-local roots. It does not
// read user configuration, infer native precedence, or report session activation.
func Scan(ctx context.Context, key, harness, workspace string, roots []RootSpec) (Inventory, error) {
	if err := ctx.Err(); err != nil {
		return Inventory{}, err
	}
	if key == "" || harness == "" || !filepath.IsAbs(workspace) || len(roots) > 64 {
		return Inventory{}, fmt.Errorf("skills: invalid station scope")
	}
	for _, r := range roots {
		if !filepath.IsLocal(r.RelativePath) || r.RelativePath == "." || strings.Contains(r.RelativePath, "\\") || filepath.Clean(r.RelativePath) != r.RelativePath || (r.Scope != "workspace" && r.Scope != "profile") {
			return Inventory{}, fmt.Errorf("skills: invalid root")
		}
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return Inventory{}, fmt.Errorf("skills: cannot open station workspace: %w", err)
	}
	defer root.Close()
	s := scanner{ctx: ctx, root: root, workspace: workspace, result: Inventory{
		StationKey: key, Harness: harness, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Skills: []Entry{}, Plugins: []Plugin{}, Issues: []Issue{},
		Coverage: Coverage{Roots: []RootCoverage{}, Limitations: []string{
			"Only the listed station-local roots were scanned. User, system, inherited and configured external roots were not inspected.",
			"Native plugin registries, eligibility, dependency availability, session loading and exercises were not queried.",
			"Entrypoint digests identify SKILL.md bytes only, not complete packages. Catalog provenance and effective precedence are unknown.",
		}},
	}}
	seen := map[string]bool{}
	for _, spec := range roots {
		if seen[spec.RelativePath] {
			continue
		}
		seen[spec.RelativePath] = true
		status := "scanned"
		err = s.walk(spec.RelativePath, spec.Scope, 0)
		switch {
		case ctx.Err() != nil:
			return Inventory{}, ctx.Err()
		case errors.Is(err, os.ErrNotExist):
			status = "missing"
		case errors.Is(err, errLimit):
			status = "truncated"
			s.issue(spec.RelativePath, "Inventory bounds reached; entries remain unobserved")
		case err != nil:
			status = "unreadable"
			s.issue(spec.RelativePath, "Root could not be inspected safely")
		}
		s.result.Coverage.Roots = append(s.result.Coverage.Roots, RootCoverage{Path: filepath.Join(workspace, spec.RelativePath), Scope: spec.Scope, Status: status})
	}
	sort.Slice(s.result.Skills, func(i, j int) bool { return s.result.Skills[i].Path < s.result.Skills[j].Path })
	byName := map[string][]string{}
	for _, entry := range s.result.Skills {
		byName[entry.Name] = append(byName[entry.Name], entry.Path)
	}
	for i := range s.result.Skills {
		for _, path := range byName[s.result.Skills[i].Name] {
			if path != s.result.Skills[i].Path {
				if len(s.result.Skills[i].Shadowing.Candidates) == 8 {
					s.issue(s.result.Skills[i].ID, "Only the first eight duplicate-name candidates are shown")
					break
				}
				s.result.Skills[i].Shadowing.Candidates = append(s.result.Skills[i].Shadowing.Candidates, path)
			}
		}
	}
	// Count/entry bounds alone do not bound a response: duplicate paths and long
	// descriptions can amplify it. Reduce the reply with explicit coverage loss.
	limited := false
	for {
		data, err := json.Marshal(s.result)
		if err != nil {
			return Inventory{}, err
		}
		if len(data) <= 2<<20 {
			return s.result, nil
		}
		if !limited {
			limited = true
			s.result.Coverage.Limitations = append(s.result.Coverage.Limitations, "Response size limit reached; skill entries or issues were omitted")
			for i := range s.result.Coverage.Roots {
				if s.result.Coverage.Roots[i].Status == "scanned" {
					s.result.Coverage.Roots[i].Status = "truncated"
				}
			}
		}
		if len(s.result.Skills) > 0 {
			s.result.Skills = s.result.Skills[:len(s.result.Skills)/2]
		} else if len(s.result.Issues) > 0 {
			s.result.Issues = s.result.Issues[:len(s.result.Issues)/2]
		} else {
			return Inventory{}, fmt.Errorf("skills: coverage exceeds response limit")
		}
	}
}
func (s *scanner) issue(rel, reason string) {
	if len(s.result.Issues) < maxIssues {
		s.result.Issues = append(s.result.Issues, Issue{Path: filepath.Join(s.workspace, rel), Reason: reason})
	}
}

// The root handle prevents traversal and symlink escapes even if files change
// during inspection. O_NOFOLLOW also rejects the final component, including
// links to a different location inside the workspace.
func (s *scanner) open(rel string, directory bool) (*os.File, error) {
	path := ""
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		path = filepath.Join(path, part)
		st, err := s.root.Lstat(path)
		if err != nil {
			return nil, err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("symlink rejected")
		}
	}
	flags := os.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	if directory {
		flags |= syscall.O_DIRECTORY
	}
	file, err := s.root.OpenFile(rel, flags, 0)
	if err != nil {
		return nil, err
	}
	st, err := file.Stat()
	if err != nil || (!directory && !st.Mode().IsRegular()) {
		file.Close()
		return nil, fmt.Errorf("not a regular entry")
	}
	return file, nil
}
func (s *scanner) walk(rel, scope string, depth int) error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	if depth > maxDepth || s.visited >= maxEntries || len(s.result.Skills) >= maxSkills || s.bytesRead >= maxTotalBytes {
		return errLimit
	}
	dir, err := s.open(rel, true)
	if err != nil {
		return err
	}
	defer dir.Close()
	entryPath := filepath.Join(rel, "SKILL.md")
	if info, err := s.root.Lstat(entryPath); err == nil {
		if !info.Mode().IsRegular() {
			s.issue(entryPath, "SKILL.md is not a regular file; it was not read")
		} else {
			if err := s.readEntry(entryPath, scope); err != nil {
				if errors.Is(err, errLimit) {
					return err
				}
				s.issue(entryPath, "SKILL.md is unreadable, oversized or has invalid name/description frontmatter")
			}
			// A skill's references/assets are not additional discovery roots.
			return nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		s.issue(entryPath, "SKILL.md could not be inspected")
	}
	for {
		entries, err := dir.ReadDir(64)
		for _, entry := range entries {
			s.visited++
			if s.visited > maxEntries {
				return errLimit
			}
			child := filepath.Join(rel, entry.Name())
			if entry.Type()&os.ModeSymlink != 0 {
				s.issue(child, "Symbolic link was not followed")
				continue
			}
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			if err := s.walk(child, scope, depth+1); err != nil {
				if errors.Is(err, errLimit) || s.ctx.Err() != nil {
					return err
				}
				s.issue(child, "Directory could not be inspected safely")
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
func (s *scanner) readEntry(rel, scope string) error {
	file, err := s.open(rel, false)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxEntrypointBytes+1))
	if err != nil {
		return err
	}
	s.bytesRead += len(data)
	if s.bytesRead > maxTotalBytes {
		return errLimit
	}
	if len(data) > maxEntrypointBytes {
		return fmt.Errorf("entrypoint too large")
	}
	name, description, err := frontmatter(data)
	if err != nil {
		return err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	present := true
	unknown := Observation{Reason: "Not observed by the filesystem adapter"}
	s.result.Skills = append(s.result.Skills, Entry{
		ID: filepath.ToSlash(rel), Name: name, Description: description, Path: filepath.Join(s.workspace, rel), Scope: scope,
		Source: Source{Kind: "local"}, EntrypointDigest: &digest,
		Shadowing:    Shadowing{Status: "unknown", Candidates: []string{}},
		Dependencies: Dependencies{Items: []Dependency{}}, Compatibility: []Compatibility{},
		Evidence: Evidence{Catalogued: unknown, Present: Observation{Value: &present, ObservedAt: &s.result.ObservedAt, Reason: "Read a regular SKILL.md entrypoint"}, Eligible: unknown, Loaded: unknown, Exercised: unknown},
	})
	return nil
}
func frontmatter(data []byte) (string, string, error) {
	text := bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	if !bytes.HasPrefix(text, []byte("---\n")) {
		return "", "", fmt.Errorf("missing frontmatter")
	}
	end := bytes.Index(text[4:], []byte("\n---"))
	if end < 0 || end > 32<<10 {
		return "", "", fmt.Errorf("missing or oversized frontmatter")
	}
	tail := text[4+end+4:]
	if len(tail) > 0 && tail[0] != '\n' {
		return "", "", fmt.Errorf("invalid delimiter")
	}
	var node yaml.Node
	if err := yaml.Unmarshal(text[4:4+end], &node); err != nil {
		return "", "", err
	}
	if len(node.Content) != 1 || node.Content[0].Kind != yaml.MappingNode {
		return "", "", fmt.Errorf("frontmatter must be a mapping")
	}
	values := map[string]string{}
	seen := map[string]bool{}
	contents := node.Content[0].Content
	for i := 0; i < len(contents); i += 2 {
		k, v := contents[i], contents[i+1]
		if k.Kind != yaml.ScalarNode || seen[k.Value] {
			return "", "", fmt.Errorf("invalid or duplicate key")
		}
		seen[k.Value] = true
		if k.Value == "name" || k.Value == "description" {
			if v.Kind != yaml.ScalarNode || v.Tag != "!!str" {
				return "", "", fmt.Errorf("identity must be a string")
			}
			values[k.Value] = strings.TrimSpace(v.Value)
		}
	}
	name, description := values["name"], values["description"]
	if name == "" || description == "" || len(name) > 256 || len(description) > 4096 || !utf8.ValidString(name+description) || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", "", fmt.Errorf("invalid identity")
	}
	return name, description, nil
}
