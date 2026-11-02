package hostfs

import (
	"errors"
	"path/filepath"
	"strings"
)

// SafeJoin joins root and rel, returning an error if rel would escape root.
//
// Absolute rel paths and ".." components that resolve outside root are both
// rejected. This helper is used by all concrete Descriptor implementations to
// sandbox file-system access inside the station's workspace.
func SafeJoin(root, rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", errors.New("descriptor: absolute path not allowed")
	}
	joined := filepath.Join(root, rel)
	cleaned := filepath.Clean(joined)
	rootClean := filepath.Clean(root)
	// Accept cleaned == rootClean (the root itself) or a strict child.
	if cleaned != rootClean && !strings.HasPrefix(cleaned, rootClean+string(filepath.Separator)) {
		return "", errors.New("descriptor: path escapes workspace root")
	}
	return cleaned, nil
}
