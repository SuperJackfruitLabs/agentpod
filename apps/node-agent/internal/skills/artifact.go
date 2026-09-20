package skills

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	maxArchiveBytes      = 32 << 20
	maxExpandedBytes     = 64 << 20
	maxArtifactFileBytes = 8 << 20
	maxArtifactFiles     = 4096
	bundleManifestName   = "sjl-bundle.json"
)

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var slugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type BundleFile struct {
	SHA256     string `json:"sha256"`
	Executable *bool  `json:"executable"`
}

type BundleSkill struct {
	ID            string   `json:"id"`
	Owner         string   `json:"owner"`
	Source        string   `json:"source"`
	Path          string   `json:"path"`
	License       string   `json:"license"`
	Notices       []string `json:"notices"`
	Prerequisites []string `json:"prerequisites"`
	Lifecycle     string   `json:"lifecycle"`
}

type BundleManifest struct {
	SchemaVersion int                   `json:"schema_version"`
	Name          string                `json:"name"`
	Version       string                `json:"version"`
	Profile       string                `json:"profile"`
	Harness       string                `json:"harness"`
	Visibility    string                `json:"visibility"`
	Skills        []BundleSkill         `json:"skills"`
	Files         map[string]BundleFile `json:"files"`
	Digest        string                `json:"digest"`
}

// Artifact is verified content, not an installed or activated package. The
// archive pin must come from the authenticated plan/catalog, never this archive.
// Its digest establishes integrity, not publisher identity or runtime safety.
type Artifact struct {
	Manifest      BundleManifest
	ArchiveSHA256 string
	Files         map[string][]byte
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

// ReadArtifact accepts the library's deterministic tar.gz format. It does not
// access the network or write files. The caller must also bound transport time;
// cancelling a context cannot interrupt an arbitrary Reader already blocked.
func ReadArtifact(ctx context.Context, input io.Reader, pin, harness string) (*Artifact, error) {
	if !digestPattern.MatchString(pin) || !knownHarness(harness) {
		return nil, fmt.Errorf("skills: invalid artifact pin or harness")
	}
	compressed, err := io.ReadAll(io.LimitReader(contextReader{ctx, input}, maxArchiveBytes+1))
	if err != nil {
		return nil, err
	}
	if len(compressed) > maxArchiveBytes {
		return nil, fmt.Errorf("skills: compressed artifact exceeds limit")
	}
	if fmt.Sprintf("%x", sha256.Sum256(compressed)) != pin {
		return nil, fmt.Errorf("skills: archive digest mismatch")
	}
	source := bytes.NewReader(compressed)
	gz, err := gzip.NewReader(source)
	if err != nil {
		return nil, fmt.Errorf("skills: invalid gzip: %w", err)
	}
	defer gz.Close()
	gz.Multistream(false)
	expanded := &io.LimitedReader{R: contextReader{ctx, gz}, N: maxExpandedBytes + 1}
	archive := tar.NewReader(expanded)
	files := map[string][]byte{}
	modes := map[string]bool{}
	seen := map[string]archivePathEntry{}
	bundleName := ""
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("skills: invalid tar: %w", err)
		}
		if len(files) >= maxArtifactFiles || header.Size < 0 || header.Size > maxArtifactFileBytes || (header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA) || (header.Mode != 0644 && header.Mode != 0755) {
			return nil, fmt.Errorf("skills: unsupported or oversized archive entry")
		}
		if !artifactPath(header.Name) {
			return nil, fmt.Errorf("skills: unsafe archive path")
		}
		name, relative, ok := strings.Cut(header.Name, "/")
		if !ok || !strings.HasPrefix(name, "sjl-") || !slugPattern.MatchString(name) || relative == ".sjl-receipt.json" {
			return nil, fmt.Errorf("skills: invalid bundle root or reserved entry")
		}
		if bundleName == "" {
			bundleName = name
		}
		if bundleName != name {
			return nil, fmt.Errorf("skills: multiple archive roots")
		}
		for key := range header.PAXRecords {
			if key != "path" {
				return nil, fmt.Errorf("skills: unsupported archive extension")
			}
		}
		if err := recordArchivePath(seen, relative); err != nil {
			return nil, err
		}
		data, err := io.ReadAll(archive)
		if err != nil {
			return nil, err
		}
		files[relative] = data
		modes[relative] = header.Mode == 0755
	}
	// Finish gzip to check its checksum. Only tar's zero padding may follow the
	// end marker; concatenated gzip members and arbitrary tails are rejected.
	padding := make([]byte, 4096)
	for {
		n, err := expanded.Read(padding)
		for _, b := range padding[:n] {
			if b != 0 {
				return nil, fmt.Errorf("skills: data follows tar end")
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	if expanded.N <= 0 || source.Len() != 0 {
		return nil, fmt.Errorf("skills: expansion limit or trailing archive data")
	}
	manifest, err := parseBundleManifest(files[bundleManifestName])
	if err != nil {
		return nil, err
	}
	if manifest.Name != bundleName || manifest.Harness != harness {
		return nil, fmt.Errorf("skills: bundle identity mismatch")
	}
	if len(manifest.Files)+1 != len(files) || modes[bundleManifestName] {
		return nil, fmt.Errorf("skills: bundle file set mismatch")
	}
	for name, meta := range manifest.Files {
		data, exists := files[name]
		if !exists || name == bundleManifestName || !artifactPath(name) || meta.Executable == nil || !digestPattern.MatchString(meta.SHA256) || *meta.Executable != modes[name] || fmt.Sprintf("%x", sha256.Sum256(data)) != meta.SHA256 {
			return nil, fmt.Errorf("skills: bundle file integrity mismatch")
		}
	}
	for _, skill := range manifest.Skills {
		entry, ok := files["skills/"+skill.ID+"/SKILL.md"]
		if !ok {
			return nil, fmt.Errorf("skills: missing skill entrypoint")
		}
		name, _, err := frontmatter(entry)
		if err != nil || name != skill.ID {
			return nil, fmt.Errorf("skills: invalid skill entrypoint")
		}
		for _, notice := range skill.Notices {
			if !artifactPath(notice) {
				return nil, fmt.Errorf("skills: invalid notice path")
			}
			if _, ok := files["notices/"+notice]; !ok {
				return nil, fmt.Errorf("skills: missing license notice")
			}
		}
	}
	return &Artifact{Manifest: manifest, ArchiveSHA256: pin, Files: files}, nil
}

type archivePathEntry struct {
	name string
	file bool
}

func recordArchivePath(seen map[string]archivePathEntry, relative string) error {
	parts := strings.Split(relative, "/")
	for i := range parts {
		name := strings.Join(parts[:i+1], "/")
		folded := strings.ToLower(name)
		file := i == len(parts)-1
		if prior, ok := seen[folded]; ok {
			if prior.name != name || prior.file || file {
				return fmt.Errorf("skills: duplicate, case-colliding or overlapping path")
			}
		} else {
			seen[folded] = archivePathEntry{name: name, file: file}
		}
	}
	return nil
}

func knownHarness(value string) bool {
	switch value {
	case "codex", "claude-code", "opencode", "pi", "hermes", "openclaw":
		return true
	}
	return false
}

// ASCII path names avoid case/Unicode-normalization aliases across Linux and
// macOS. Unicode skill content and metadata remain supported.
func artifactPath(value string) bool {
	if value == "" || len(value) > 1024 || path.IsAbs(value) || path.Clean(value) != value || strings.ContainsAny(value, "\\:") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
	}
	for _, r := range value {
		if r < 32 || r >= 127 {
			return false
		}
	}
	return true
}

func parseBundleManifest(data []byte) (BundleManifest, error) {
	var manifest BundleManifest
	if len(data) == 0 || len(data) > 2<<20 || !utf8.Valid(data) {
		return manifest, fmt.Errorf("skills: missing or oversized bundle manifest")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := uniqueJSON(decoder, 0)
	if err != nil {
		return manifest, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return manifest, fmt.Errorf("skills: trailing manifest data")
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) != 9 {
		return manifest, fmt.Errorf("skills: invalid bundle manifest fields")
	}
	strict := json.NewDecoder(bytes.NewReader(data))
	strict.DisallowUnknownFields()
	if err := strict.Decode(&manifest); err != nil {
		return manifest, err
	}
	if manifest.SchemaVersion != 1 || !slugPattern.MatchString(manifest.Profile) || manifest.Name != "sjl-"+manifest.Profile || len(manifest.Name) > 128 || manifest.Version == "" || !knownHarness(manifest.Harness) || (manifest.Visibility != "private" && manifest.Visibility != "public") || len(manifest.Skills) == 0 || len(manifest.Skills) > 256 || len(manifest.Files) == 0 || !digestPattern.MatchString(manifest.Digest) {
		return manifest, fmt.Errorf("skills: invalid bundle identity")
	}
	delete(object, "digest")
	canonical, err := libraryJSON(object)
	if err != nil {
		return manifest, err
	}
	if fmt.Sprintf("%x", sha256.Sum256(canonical)) != manifest.Digest {
		return manifest, fmt.Errorf("skills: manifest digest mismatch")
	}
	seen := map[string]bool{}
	for _, skill := range manifest.Skills {
		if !slugPattern.MatchString(skill.ID) || len(skill.ID) > 64 || seen[skill.ID] || skill.Owner == "" || skill.License == "" || skill.Path == "" || len(skill.Notices) == 0 || skill.Prerequisites == nil || (skill.Source != "sjl" && skill.Source != "upstream" && skill.Source != "product") || (skill.Lifecycle != "candidate" && skill.Lifecycle != "stable" && skill.Lifecycle != "deprecated") {
			return manifest, fmt.Errorf("skills: invalid skill metadata")
		}
		seen[skill.ID] = true
	}
	return manifest, nil
}

// Decode with duplicate-key and depth checks instead of JSON's last-key-wins.
func uniqueJSON(decoder *json.Decoder, depth int) (any, error) {
	if depth > 32 {
		return nil, fmt.Errorf("skills: manifest nesting limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return token, nil
	}
	switch delim {
	case '{':
		object := map[string]any{}
		for decoder.More() {
			token, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := token.(string)
			if !ok {
				return nil, fmt.Errorf("skills: invalid JSON key")
			}
			if _, ok := object[key]; ok {
				return nil, fmt.Errorf("skills: duplicate JSON key")
			}
			value, err := uniqueJSON(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return object, nil
	case '[':
		array := []any{}
		for decoder.More() {
			value, err := uniqueJSON(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return array, nil
	}
	return nil, fmt.Errorf("skills: unexpected JSON delimiter")
}

// Match the library's json.dumps(indent=2, sort_keys=True, ensure_ascii=False)
// plus newline. Go's standard string encoder escapes U+2028/2029 even with HTML
// escaping disabled, so strings are emitted explicitly before indentation.
func libraryJSON(value any) ([]byte, error) {
	var compact bytes.Buffer
	var write func(any) error
	write = func(v any) error {
		switch x := v.(type) {
		case nil:
			compact.WriteString("null")
		case bool:
			if x {
				compact.WriteString("true")
			} else {
				compact.WriteString("false")
			}
		case json.Number:
			if x.String() != "1" {
				return fmt.Errorf("skills: unsupported numeric manifest metadata")
			}
			compact.WriteString("1")
		case string:
			compact.WriteByte('"')
			for _, r := range x {
				switch r {
				case '"', '\\':
					compact.WriteByte('\\')
					compact.WriteRune(r)
				case '\b':
					compact.WriteString(`\b`)
				case '\f':
					compact.WriteString(`\f`)
				case '\n':
					compact.WriteString(`\n`)
				case '\r':
					compact.WriteString(`\r`)
				case '\t':
					compact.WriteString(`\t`)
				default:
					if r < 32 {
						fmt.Fprintf(&compact, `\u%04x`, r)
					} else {
						compact.WriteRune(r)
					}
				}
			}
			compact.WriteByte('"')
		case []any:
			compact.WriteByte('[')
			for i, item := range x {
				if i > 0 {
					compact.WriteByte(',')
				}
				if err := write(item); err != nil {
					return err
				}
			}
			compact.WriteByte(']')
		case map[string]any:
			keys := make([]string, 0, len(x))
			for key := range x {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			compact.WriteByte('{')
			for i, key := range keys {
				if i > 0 {
					compact.WriteByte(',')
				}
				write(key)
				compact.WriteByte(':')
				if err := write(x[key]); err != nil {
					return err
				}
			}
			compact.WriteByte('}')
		default:
			return fmt.Errorf("skills: unsupported manifest value")
		}
		return nil
	}
	if err := write(value); err != nil {
		return nil, err
	}
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, compact.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	formatted.WriteByte('\n')
	return formatted.Bytes(), nil
}
