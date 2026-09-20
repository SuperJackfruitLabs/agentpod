package skills

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"syscall"
)

type generationReceipt struct {
	Binding    InstallBinding `json:"binding"`
	Generation Generation     `json:"generation"`
}

func validGeneration(g *Generation) bool {
	return g == nil || (operationPattern.MatchString(g.Generation) && digestPattern.MatchString(g.ArchiveSHA256) && digestPattern.MatchString(g.BundleDigest))
}

func (s *InstallStore) verifyGeneration(ctx context.Context, g *Generation) (*BundleManifest, error) {
	if g == nil {
		return nil, nil
	}
	if !validGeneration(g) {
		return nil, fmt.Errorf("skills: invalid generation")
	}
	directory := "generations/" + g.Generation
	var receipt generationReceipt
	if err := s.readJSON(directory+"/.sjl-receipt.json", &receipt); err != nil {
		return nil, err
	}
	if receipt.Binding != s.binding || receipt.Generation != *g {
		return nil, fmt.Errorf("%w: generation ownership differs", ErrInstallConflict)
	}
	data, err := readManaged(s.root, directory+"/"+bundleManifestName, 2<<20)
	if err != nil {
		return nil, err
	}
	manifest, err := parseBundleManifest(data)
	if err != nil {
		return nil, err
	}
	if manifest.Harness != s.binding.Harness || manifest.Profile != s.binding.Profile || manifest.Digest != g.BundleDigest {
		return nil, fmt.Errorf("%w: generation manifest differs", ErrInstallConflict)
	}
	if err := s.verifyFiles(ctx, directory, manifest.Files, false); err != nil {
		return nil, err
	}
	return &manifest, nil
}

// Read-only verification never trusts an old receipt to establish current bytes.
// During recovery, partial staging may omit files, but may not alter or add any.
func (s *InstallStore) verifyFiles(ctx context.Context, directory string, files map[string]BundleFile, partial bool) error {
	if err := checkComponents(s.root, directory); err != nil {
		return err
	}
	root, err := s.root.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	seen := map[string]bool{}
	count, total := 0, int64(0)
	err = walkManaged(ctx, root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		count++
		if count > maxArtifactFiles*4+2 {
			return fmt.Errorf("skills: generation entry limit")
		}
		if name == "." {
			return nil
		}
		if !artifactPath(name) || entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: unsafe generation entry", ErrInstallConflict)
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("%w: special generation file", ErrInstallConflict)
		}
		if name == ".sjl-receipt.json" || name == bundleManifestName {
			info, err := root.Lstat(name)
			if err != nil {
				return err
			}
			if info.Mode()&0111 != 0 {
				return fmt.Errorf("%w: executable generation metadata", ErrInstallConflict)
			}
			return nil
		}
		meta, ok := files[name]
		if !ok {
			return fmt.Errorf("%w: unexpected generation file", ErrInstallConflict)
		}
		data, err := readManaged(root, name, maxArtifactFileBytes)
		if err != nil {
			return err
		}
		total += int64(len(data))
		if total > maxExpandedBytes {
			return fmt.Errorf("skills: generation size limit")
		}
		info, err := root.Lstat(name)
		if err != nil {
			return err
		}
		if meta.Executable == nil || hashBytes(data) != meta.SHA256 || (info.Mode()&0111 != 0) != *meta.Executable {
			return fmt.Errorf("%w: generation content or mode changed", ErrInstallConflict)
		}
		seen[name] = true
		return nil
	})
	if err != nil {
		return err
	}
	if !partial && len(seen) != len(files) {
		return fmt.Errorf("%w: generation file missing", ErrInstallConflict)
	}
	return nil
}

// Read directory batches, not an unbounded ReadDir(-1) before enforcing limits.
func walkManaged(ctx context.Context, root *os.Root, visit func(string, fs.DirEntry, error) error) error {
	var walk func(string) error
	walk = func(relative string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := checkComponents(root, relative); err != nil {
			return err
		}
		directory, err := root.OpenFile(relative, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		defer directory.Close()
		for {
			entries, err := directory.ReadDir(64)
			for _, entry := range entries {
				name := path.Join(relative, entry.Name())
				if err := visit(name, entry, nil); err != nil {
					return err
				}
				if entry.IsDir() {
					if err := walk(name); err != nil {
						return err
					}
				}
			}
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return err
			}
		}
	}
	return walk(".")
}

func (s *InstallStore) stage(ctx context.Context, plan InstallPlan, artifact *Artifact) error {
	destination := "generations/" + plan.OperationID
	if _, err := s.root.Lstat(destination); err == nil {
		_, err = s.verifyGeneration(ctx, plan.After)
		return err
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	stage := "staging/" + plan.OperationID
	if err := makeDirs(s.root, stage); err != nil {
		return err
	}
	if err := s.verifyFiles(ctx, stage, artifact.Manifest.Files, true); err != nil {
		return err
	}
	keys := make([]string, 0, len(artifact.Files))
	for name := range artifact.Files {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	for _, name := range keys {
		if err := ctx.Err(); err != nil {
			return err
		}
		relative := path.Join(stage, name)
		if existing, err := readManaged(s.root, relative, maxArtifactFileBytes); err == nil {
			if !bytes.Equal(existing, artifact.Files[name]) {
				return fmt.Errorf("%w: staging file changed", ErrInstallConflict)
			}
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := makeDirs(s.root, path.Dir(relative)); err != nil {
			return err
		}
		mode := fs.FileMode(0644)
		if meta, ok := artifact.Manifest.Files[name]; ok && *meta.Executable {
			mode = 0755
		}
		if err := s.atomicWrite(relative, artifact.Files[name], mode, true); err != nil {
			return err
		}
		if err := s.checkpoint("file"); err != nil {
			return err
		}
	}
	expected := generationReceipt{Binding: s.binding, Generation: *plan.After}
	var existing generationReceipt
	if err := s.readJSON(stage+"/.sjl-receipt.json", &existing); err == nil {
		if existing != expected {
			return fmt.Errorf("%w: staging receipt changed", ErrInstallConflict)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := s.writeJSON(stage+"/.sjl-receipt.json", expected); err != nil {
			return err
		}
	} else {
		return err
	}
	if err := s.verifyFiles(ctx, stage, artifact.Manifest.Files, false); err != nil {
		return err
	}
	// Flush child directories before publishing the generation name.
	dirs := map[string]bool{stage: true}
	for _, name := range keys {
		for dir := path.Dir(path.Join(stage, name)); dir != stage; dir = path.Dir(dir) {
			dirs[dir] = true
		}
	}
	ordered := make([]string, 0, len(dirs))
	for dir := range dirs {
		ordered = append(ordered, dir)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ordered)))
	for _, dir := range ordered {
		if err := syncDir(s.root, dir); err != nil {
			return err
		}
	}
	if err := s.root.Rename(stage, destination); err != nil {
		return err
	}
	if err := syncDir(s.root, "staging"); err != nil {
		return err
	}
	if err := syncDir(s.root, "generations"); err != nil {
		return err
	}
	if _, err := s.verifyGeneration(ctx, plan.After); err != nil {
		return err
	}
	return s.checkpoint("generation")
}

func installDiff(before, after *BundleManifest) InstallChanges {
	changes := InstallChanges{Added: []string{}, Removed: []string{}, Changed: []string{}}
	old, next := map[string]BundleFile{}, map[string]BundleFile{}
	if before != nil {
		for name, meta := range before.Files {
			old[name] = meta
		}
		executable := false
		old[bundleManifestName] = BundleFile{SHA256: before.rawSHA256, Executable: &executable}
	}
	if after != nil {
		for name, meta := range after.Files {
			next[name] = meta
		}
		executable := false
		next[bundleManifestName] = BundleFile{SHA256: after.rawSHA256, Executable: &executable}
	}
	for name, meta := range next {
		prior, ok := old[name]
		if !ok {
			changes.Added = append(changes.Added, name)
		} else if meta.SHA256 != prior.SHA256 || *meta.Executable != *prior.Executable {
			changes.Changed = append(changes.Changed, name)
		}
	}
	for name := range old {
		if _, ok := next[name]; !ok {
			changes.Removed = append(changes.Removed, name)
		}
	}
	sort.Strings(changes.Added)
	sort.Strings(changes.Removed)
	sort.Strings(changes.Changed)
	return changes
}
