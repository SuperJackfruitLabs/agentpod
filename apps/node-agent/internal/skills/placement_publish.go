package skills

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
)

func (s *InstallStore) stagePlacement(ctx context.Context, id string, g *Generation, m *BundleManifest, layout string) error {
	if s.binding.Harness == "codex" && layout == codexDirectLayout {
		return s.stageCodexPlacement(ctx, id, g, m)
	}
	stage := "native/staging/" + id
	if err := makeDirs(s.root, stage); err != nil {
		return err
	}
	if err := s.verifyFiles(ctx, stage, m.Files, true); err != nil {
		return err
	}
	names := []string{bundleManifestName, ".sjl-receipt.json"}
	for name := range m.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	dirs := map[string]bool{stage: true}
	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return err
		}
		data, err := readManaged(s.root, "generations/"+g.Generation+"/"+name, maxArtifactFileBytes)
		if err != nil {
			return err
		}
		relative := path.Join(stage, name)
		if existing, err := readManaged(s.root, relative, maxArtifactFileBytes); err == nil {
			if !bytes.Equal(existing, data) {
				return fmt.Errorf("%w: native staged file changed", ErrInstallConflict)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		} else {
			if err = makeDirs(s.root, path.Dir(relative)); err != nil {
				return err
			}
			mode := fs.FileMode(0644)
			if meta, ok := m.Files[name]; ok && *meta.Executable {
				mode = 0755
			}
			if err = s.atomicWrite(relative, data, mode, true); err != nil {
				return err
			}
		}
		for dir := path.Dir(relative); dir != stage; dir = path.Dir(dir) {
			dirs[dir] = true
		}
	}
	ordered := []string{}
	for dir := range dirs {
		ordered = append(ordered, dir)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ordered)))
	for _, dir := range ordered {
		if err := syncDir(s.root, dir); err != nil {
			return err
		}
	}
	if _, err := s.verifyGenerationAt(ctx, stage, g); err != nil {
		return err
	}
	return s.checkpoint("native-stage")
}
func (s *InstallStore) publishPlacement(ctx context.Context, r *PlacementReceipt, workspace *InstallStore, target string, before, after *BundleManifest, beforeLayout string) error {
	p := r.Plan
	namespace, err := filepath.Rel(s.binding.WorkspacePath, s.directory)
	if err != nil || !managedPath(filepath.ToSlash(namespace)) {
		return fmt.Errorf("skills: native namespace escaped workspace")
	}
	namespace = filepath.ToSlash(namespace)
	backup := path.Join(namespace, "native/backups", p.OperationID)
	stage := path.Join(namespace, "native/staging", p.OperationID)
	backupExists := false
	if _, err = workspace.root.Lstat(backup); err == nil {
		if p.Before == nil {
			return fmt.Errorf("%w: unexpected native backup", ErrInstallConflict)
		}
		if err = s.verifyPlaced(ctx, workspace, backup, p.Before, beforeLayout); err != nil {
			return err
		}
		backupExists = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	targetExists := false
	if _, err = workspace.root.Lstat(target); err == nil {
		targetExists = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// A previous attempt may already have published the desired bytes. Require
	// the preserved prior copy whenever the plan started from a present target.
	if targetExists && p.After != nil && s.verifyPlaced(ctx, workspace, target, p.After, p.NativeLayout) == nil {
		if p.Before != nil && !backupExists {
			return fmt.Errorf("%w: native prior copy is missing", ErrInstallConflict)
		}
		return nil
	}
	if targetExists {
		if err = s.verifyPlaced(ctx, workspace, target, p.Before, beforeLayout); err != nil {
			return err
		}
		if backupExists {
			return fmt.Errorf("%w: duplicate native prior copy", ErrInstallConflict)
		}
	} else if p.Before != nil && !backupExists {
		return fmt.Errorf("%w: native target and prior copy are both missing", ErrInstallConflict)
	}
	if p.After != nil {
		if err = s.stagePlacement(ctx, p.OperationID, p.After, after, p.NativeLayout); err != nil {
			return err
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = s.savePlacement(r, "switching"); err != nil {
		return err
	}
	if err = s.checkIdentity(); err != nil {
		return err
	}
	if targetExists {
		if err = s.verifyPlaced(ctx, workspace, target, p.Before, beforeLayout); err != nil {
			return err
		}
		if err = checkComponents(workspace.root, path.Dir(backup)); err != nil {
			return err
		}
		if err = workspace.root.Rename(target, backup); err != nil {
			return err
		}
		if err = syncDir(workspace.root, path.Dir(target)); err != nil {
			return err
		}
		if err = syncDir(workspace.root, path.Dir(backup)); err != nil {
			return err
		}
		if err = s.checkpoint("native-backup"); err != nil {
			return err
		}
	}
	if p.After != nil {
		if err = makeDirs(workspace.root, path.Dir(target)); err != nil {
			return err
		}
		if err = s.verifyPlaced(ctx, workspace, target, nil, p.NativeLayout); err != nil {
			return err
		}
		if err = s.verifyPlaced(ctx, workspace, stage, p.After, p.NativeLayout); err != nil {
			return err
		}
		if err = workspace.root.Rename(stage, target); err != nil {
			return err
		}
		if err = syncDir(workspace.root, path.Dir(stage)); err != nil {
			return err
		}
		if err = syncDir(workspace.root, path.Dir(target)); err != nil {
			return err
		}
		if err = s.checkpoint("native-publish"); err != nil {
			return err
		}
	}
	return s.verifyPlaced(ctx, workspace, target, p.After, p.NativeLayout)
}
