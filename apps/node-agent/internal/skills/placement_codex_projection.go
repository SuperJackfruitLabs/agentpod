package skills

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
)

// codexNativeProjection is deliberately a direct skill directory.  Codex scans
// each immediate child of .agents/skills for SKILL.md; a bundled skills/<id>
// subtree is not a discoverable native skill.
func codexNativeProjection(m *BundleManifest) (map[string]BundleFile, map[string]string, error) {
	if m == nil || len(m.Skills) != 1 {
		return nil, nil, fmt.Errorf("skills: Codex native placement requires exactly one plain skill")
	}
	prefix := "skills/" + m.Skills[0].ID + "/"
	files, source := map[string]BundleFile{}, map[string]string{}
	for name, meta := range m.Files {
		if relative, ok := strings.CutPrefix(name, prefix); ok {
			files[relative] = meta
			source[relative] = name
		}
	}
	if _, ok := files["SKILL.md"]; !ok {
		return nil, nil, fmt.Errorf("skills: Codex native placement has no skill entrypoint")
	}
	return files, source, nil
}

// The reviewed native diff uses destination paths, including the migration
// from a previously published grouped export. The source bundle manifest is
// unchanged and remains the authority for the bytes in each projected file.
func codexPlacementDiff(before, after *BundleManifest, beforeLayout string) (InstallChanges, error) {
	old, next := map[string]string{}, map[string]string{}
	if before != nil {
		if beforeLayout == codexDirectLayout {
			files, _, err := codexNativeProjection(before)
			if err != nil {
				return InstallChanges{}, err
			}
			for name, meta := range files {
				old[name] = meta.SHA256
			}
		} else {
			for name, meta := range before.Files {
				old[name] = meta.SHA256
			}
			old[bundleManifestName] = before.rawSHA256
			old[".sjl-receipt.json"] = "legacy-receipt"
		}
	}
	if after != nil {
		files, _, err := codexNativeProjection(after)
		if err != nil {
			return InstallChanges{}, err
		}
		for name, meta := range files {
			next[name] = meta.SHA256
		}
	}
	changes := InstallChanges{Added: []string{}, Removed: []string{}, Changed: []string{}}
	for name, digest := range next {
		prior, ok := old[name]
		if !ok {
			changes.Added = append(changes.Added, name)
		} else if prior != digest {
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
	return changes, nil
}

func (s *InstallStore) stageCodexPlacement(ctx context.Context, id string, g *Generation, m *BundleManifest) error {
	stage := "native/staging/" + id
	files, source, err := codexNativeProjection(m)
	if err != nil {
		return err
	}
	if err = makeDirs(s.root, stage); err != nil {
		return err
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err = ctx.Err(); err != nil {
			return err
		}
		data, err := readManaged(s.root, "generations/"+g.Generation+"/"+source[name], maxArtifactFileBytes)
		if err != nil {
			return err
		}
		relative := path.Join(stage, name)
		if existing, readErr := readManaged(s.root, relative, maxArtifactFileBytes); readErr == nil {
			if !bytes.Equal(existing, data) {
				return fmt.Errorf("%w: native staged file changed", ErrInstallConflict)
			}
			continue
		} else if !errors.Is(readErr, os.ErrNotExist) {
			return readErr
		}
		if err = makeDirs(s.root, path.Dir(relative)); err != nil {
			return err
		}
		if err = s.atomicWrite(relative, data, 0644, true); err != nil {
			return err
		}
	}
	if err = verifyCodexProjection(ctx, s.root, stage, s, g, m); err != nil {
		return err
	}
	return s.checkpoint("native-stage")
}

func verifyCodexProjection(ctx context.Context, root *os.Root, directory string, source *InstallStore, g *Generation, m *BundleManifest) error {
	if g == nil {
		if _, err := root.Lstat(directory); errors.Is(err, os.ErrNotExist) {
			return nil
		} else if err != nil {
			return err
		}
		return fmt.Errorf("%w: unowned native destination", ErrInstallConflict)
	}
	files, paths, err := codexNativeProjection(m)
	if err != nil {
		return err
	}
	if err = checkComponents(root, directory); err != nil {
		return err
	}
	seen := map[string]bool{}
	scan, err := root.OpenRoot(directory)
	if err != nil {
		return err
	}
	err = walkManaged(ctx, scan, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if name == "." || entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return fmt.Errorf("%w: unsafe native skill entry", ErrInstallConflict)
		}
		meta, ok := files[name]
		if !ok {
			return fmt.Errorf("%w: unexpected native skill file", ErrInstallConflict)
		}
		got, err := readManaged(scan, name, maxArtifactFileBytes)
		if err != nil {
			return err
		}
		want, err := readManaged(source.root, "generations/"+g.Generation+"/"+paths[name], maxArtifactFileBytes)
		if err != nil {
			return err
		}
		if hashBytes(got) != meta.SHA256 || !bytes.Equal(got, want) {
			return fmt.Errorf("%w: native skill content changed", ErrInstallConflict)
		}
		seen[name] = true
		return nil
	})
	scan.Close()
	if err != nil {
		return err
	}
	if len(seen) != len(files) {
		return fmt.Errorf("%w: native skill file missing", ErrInstallConflict)
	}
	return nil
}
