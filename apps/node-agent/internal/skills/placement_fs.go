package skills

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

var placementRoots = map[string]string{"codex": ".agents/skills", "opencode": ".opencode/skills", "pi": ".pi/skills", "openclaw": "skills"}
var placementScanRoots = []string{".agents/skills", ".claude/skills", ".opencode/skills", ".pi/skills", ".hermes/skills", "skills"}

func (s *InstallStore) placementTarget() (string, error) {
	root, ok := placementRoots[s.binding.Harness]
	if !ok {
		return "", fmt.Errorf("skills: native grouped placement is unverified for %s", s.binding.Harness)
	}
	target := root + "/sjl-" + s.binding.Profile
	if len(filepath.Join(s.binding.WorkspacePath, target)) > 4096 {
		return "", fmt.Errorf("skills: native destination exceeds limit")
	}
	return target, nil
}
func (s *InstallStore) placementRepository() (string, string, error) {
	for p := s.binding.WorkspacePath; ; p = filepath.Dir(p) {
		marker := filepath.Join(p, ".git")
		info, err := os.Lstat(marker)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
				return "", "", fmt.Errorf("%w: ambiguous Git marker", ErrInstallConflict)
			}
			dir, err := os.Stat(p)
			if err != nil {
				return "", "", err
			}
			a, ok := dir.Sys().(*syscall.Stat_t)
			b, ok2 := info.Sys().(*syscall.Stat_t)
			if !ok || !ok2 {
				return "", "", fmt.Errorf("skills: unsupported repository identity")
			}
			return p, hashBytes([]byte(fmt.Sprintf("%s:%d:%d:%d:%d", p, a.Dev, a.Ino, b.Dev, b.Ino))), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", "", err
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	return "", "", fmt.Errorf("skills: native project placement requires a Git workspace")
}

// This lock coordinates cooperating placement writers across nested workspaces.
// It is not a session lease or a lock respected by external editors/harnesses.
func (s *InstallStore) placementLock(ctx context.Context) (string, string, func(), error) {
	repo, identity, err := s.placementRepository()
	if err != nil {
		return "", "", nil, err
	}
	root, err := os.OpenRoot(repo)
	if err != nil {
		return "", "", nil, err
	}
	defer root.Close()
	if err = makeDirs(root, ".agentpod-skills"); err != nil {
		return "", "", nil, err
	}
	file, err := openManaged(root, ".agentpod-skills/native.lock", os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return "", "", nil, err
	}
	for {
		if err = ctx.Err(); err != nil {
			file.Close()
			return "", "", nil, err
		}
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			file.Close()
			return "", "", nil, err
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			file.Close()
			return "", "", nil, ctx.Err()
		case <-timer.C:
		}
	}
	release := func() { syscall.Flock(int(file.Fd()), syscall.LOCK_UN); file.Close() }
	again, identityAgain, err := s.placementRepository()
	if err != nil || again != repo || identityAgain != identity {
		release()
		return "", "", nil, fmt.Errorf("%w: repository identity changed", ErrInstallConflict)
	}
	return repo, identity, release, nil
}
func (s *InstallStore) placementCollisions(ctx context.Context, repo, target string, manifests ...*BundleManifest) error {
	names := map[string]bool{}
	for _, m := range manifests {
		if m != nil {
			for _, skill := range m.Skills {
				names[skill.ID] = true
			}
		}
	}
	// Removal introduces no names and must preserve unrelated user drafts.
	if len(names) == 0 {
		return nil
	}
	examined, bytesRead := 0, 0
	for directory := s.binding.WorkspacePath; ; directory = filepath.Dir(directory) {
		root, err := os.OpenRoot(directory)
		if err != nil {
			return err
		}
		err = func() error {
			for _, relative := range placementScanRoots {
				if err := checkComponents(root, relative); errors.Is(err, os.ErrNotExist) {
					continue
				} else if err != nil {
					return err
				}
				scan, err := root.OpenRoot(relative)
				if err != nil {
					return err
				}
				err = walkManaged(ctx, scan, func(name string, entry fs.DirEntry, _ error) error {
					full := filepath.Join(directory, relative, name)
					if full == target && entry.IsDir() {
						return fs.SkipDir
					}
					examined++
					if examined > 8192 || len(strings.Split(name, "/")) > 64 {
						return fmt.Errorf("skills: project collision scan exceeds bounds")
					}
					if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !entry.Type().IsRegular()) {
						return fmt.Errorf("%w: ambiguous project skill entry", ErrInstallConflict)
					}
					if entry.IsDir() || path.Base(name) != "SKILL.md" {
						return nil
					}
					data, err := readManaged(scan, name, maxEntrypointBytes)
					if err != nil {
						return err
					}
					bytesRead += len(data)
					if bytesRead > maxTotalBytes {
						return fmt.Errorf("skills: project scan bytes exceed bounds")
					}
					skillName, _, err := frontmatter(data)
					if err != nil {
						return fmt.Errorf("%w: ambiguous project skill identity", ErrInstallConflict)
					}
					if names[skillName] || names[path.Base(path.Dir(name))] {
						return fmt.Errorf("%w: duplicate project skill name %s", ErrInstallConflict, skillName)
					}
					return nil
				})
				scan.Close()
				if err != nil {
					return err
				}
			}
			return nil
		}()
		root.Close()
		if err != nil {
			return err
		}
		if directory == repo {
			break
		}
	}
	return nil
}
func (s *InstallStore) placementWorkspace() (*InstallStore, error) {
	root, err := os.OpenRoot(s.binding.WorkspacePath)
	if err != nil {
		return nil, err
	}
	return &InstallStore{root: root, binding: s.binding}, nil
}
func (s *InstallStore) verifyPlaced(ctx context.Context, workspace *InstallStore, relative string, g *Generation) error {
	if g == nil {
		if _, err := workspace.root.Lstat(relative); errors.Is(err, os.ErrNotExist) {
			return nil
		} else if err != nil {
			return err
		}
		return fmt.Errorf("%w: unowned native destination", ErrInstallConflict)
	}
	if _, err := workspace.verifyGenerationAt(ctx, relative, g); err != nil {
		return fmt.Errorf("%w: native files differ: %v", ErrInstallConflict, err)
	}
	return nil
}
