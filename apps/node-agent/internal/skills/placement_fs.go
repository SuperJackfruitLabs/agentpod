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

var placementRoots = map[string]string{"codex": ".agents/skills", "claude-code": ".claude/skills", "hermes": "managed-skills", "opencode": ".opencode/skills", "pi": ".pi/skills", "openclaw": "skills"}
var placementScanRoots = []string{".agents/skills", ".claude/skills", ".opencode/skills", ".pi/skills", ".hermes/skills", "skills"}

const (
	codexDirectLayout  = "codex-direct-v1"
	claudeDirectLayout = "claude-direct-v1"
	hermesDirectLayout = "hermes-direct-v1"
)

// Harnesses whose native discovery reads a direct skill directory rather than
// a grouped bundle export. Codex scans each immediate child of .agents/skills
// for SKILL.md; Claude reads .claude/skills the same way, and its grouped
// layout was probed and does not load. Each entry publishes one plain skill at
// the destination root, so they share a projection.
var directLayouts = map[string]string{"codex": codexDirectLayout, "claude-code": claudeDirectLayout, "hermes": hermesDirectLayout}

// Harnesses whose station is not a source checkout. A Hermes station is a
// profile directory and an OpenClaw station is the OpenClaw home: each is its
// own coordination boundary rather than a project, has no .git, and one must
// never be created inside a user's home to satisfy a binding. These bind to
// the workspace itself.
var nonRepositoryWorkspaces = map[string]bool{"hermes": true, "openclaw": true}

// directLayout reports the layout this binding's harness requires, and whether
// it requires one at all. A harness absent from the map keeps the grouped
// export, whose own evidence is recorded separately.
func (s *InstallStore) directLayout() (string, bool) {
	layout, ok := directLayouts[s.binding.Harness]
	return layout, ok
}

// isDirectLayout reports whether a recorded layout is the one this binding's
// harness requires. A layout recorded for the wrong harness, or an unknown
// one, is not accepted: a plan or head carrying it describes a placement this
// node cannot verify.
func (s *InstallStore) isDirectLayout(layout string) bool {
	want, ok := s.directLayout()
	return ok && layout == want
}

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

// placementRepository resolves the root that identifies and coordinates a
// placement. For a source checkout that is the enclosing Git work tree, whose
// identity covers a replaced or renamed repository. A harness whose station is
// not a checkout binds to the workspace itself: the identity still moves if the
// directory is replaced, and the two modes hash under different prefixes so an
// identity from one can never satisfy the other.
func (s *InstallStore) placementRepository() (string, string, error) {
	if nonRepositoryWorkspaces[s.binding.Harness] {
		p := s.binding.WorkspacePath
		dir, err := os.Stat(p)
		if err != nil {
			return "", "", err
		}
		if !dir.IsDir() {
			return "", "", fmt.Errorf("%w: workspace is not a directory", ErrInstallConflict)
		}
		a, ok := dir.Sys().(*syscall.Stat_t)
		if !ok {
			return "", "", fmt.Errorf("skills: unsupported workspace identity")
		}
		return p, hashBytes([]byte(fmt.Sprintf("workspace:%s:%d:%d", p, a.Dev, a.Ino))), nil
	}
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

// harnessInventoryCollision compares the harness's reported names with the
// ones this placement introduces.
//
// `owned` are the names this placement already publishes, which the harness
// will of course report; re-placing what we put there is not a collision with
// ourselves. A report that cannot be read is an ERROR rather than an empty
// inventory: reading a failed report as "nothing is taken" would publish over
// a name the harness holds, which is the one outcome this check exists to stop.
// placedNames are the skill names a generation publishes, used to tell "this
// name is already ours" from "this name belongs to something else".
//
// A generation whose manifest cannot be read yields no names rather than an
// error: the caller then treats every reported name as foreign, which refuses
// a re-placement it could have allowed. Failing closed here costs a retry;
// failing open would publish over a neighbour.
func (s *InstallStore) placedNames(ctx context.Context, g *Generation) map[string]bool {
	if g == nil {
		return nil
	}
	manifest, err := s.verifyGeneration(ctx, g)
	if err != nil || manifest == nil {
		return nil
	}
	owned := make(map[string]bool, len(manifest.Skills))
	for _, skill := range manifest.Skills {
		owned[skill.ID] = true
	}
	return owned
}

func harnessInventoryCollision(listed map[string]string, names, owned map[string]bool) error {
	for name := range names {
		if owned[name] {
			continue
		}
		if _, taken := listed[name]; taken {
			return fmt.Errorf("%w: duplicate project skill name %s", ErrInstallConflict, name)
		}
	}
	return nil
}

func (s *InstallStore) placementCollisions(ctx context.Context, repo, target string, owned map[string]bool, manifests ...*BundleManifest) error {
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
	// A harness that can report its own inventory is asked instead of walked.
	// A reporter that answers with no inventory and no error is saying "this
	// harness cannot report", and the walk stays in charge.
	if s.reportedSkills != nil {
		listed, err := s.reportedSkills(ctx)
		if err != nil {
			return fmt.Errorf("skills: %s could not report which skill names exist: %w", s.binding.Harness, err)
		}
		if listed != nil {
			return harnessInventoryCollision(listed, names, owned)
		}
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
func (s *InstallStore) verifyPlaced(ctx context.Context, workspace *InstallStore, relative string, g *Generation, layout string) error {
	if want, direct := s.directLayout(); direct && layout == want {
		manifest, err := s.verifyGeneration(ctx, g)
		if err != nil {
			return err
		}
		if err := verifyDirectProjection(ctx, workspace.root, relative, s, g, manifest); err != nil {
			return fmt.Errorf("%w: native files differ: %v", ErrInstallConflict, err)
		}
		return nil
	}
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
