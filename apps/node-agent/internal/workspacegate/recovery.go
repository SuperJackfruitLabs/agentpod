package workspacegate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// RecoveryMarker is written by the native placement transaction before it
// changes discovery files. Session admission inspects existence only; recovery
// validates the operation binding before removing it.
const RecoveryMarker = ".agentpod-skills/admission/fence.json"

var ErrRecoveryRequired = errors.New("workspace: native publication requires recovery")

// checkRecovery inspects the resolved cwd and its ancestors without creating
// state. Checking every ancestor also covers nested Git repositories. It does
// not enumerate descendant repositories or detect later changes of cwd.
func checkRecovery(ctx context.Context, dir string) error {
	for p := dir; ; p = filepath.Dir(p) {
		if err := ctx.Err(); err != nil {
			return err
		}
		for i, relative := range []string{".agentpod-skills", ".agentpod-skills/admission", RecoveryMarker} {
			info, err := os.Lstat(filepath.Join(p, relative))
			if errors.Is(err, os.ErrNotExist) {
				break
			}
			if err != nil {
				return fmt.Errorf("%w: cannot inspect admission state: %v", ErrRecoveryRequired, err)
			}
			if i == 2 || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return ErrRecoveryRequired
			}
		}
		if p == filepath.Dir(p) {
			return nil
		}
	}
}
