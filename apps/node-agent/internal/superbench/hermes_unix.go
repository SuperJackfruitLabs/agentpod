//go:build unix

package superbench

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func checkHermesConfig(c HermesConfig) error {
	for _, s := range []string{c.Provider, c.Model} {
		if s == "" || len(s) > 255 || strings.ContainsAny(s, "\x00\r\n") || strings.HasPrefix(s, "-") {
			return ErrHermesConfig
		}
	}
	if !filepath.IsAbs(c.Executable) || !filepath.IsAbs(c.Home) || filepath.Clean(c.Home) != c.Home || c.Home == "/" {
		return ErrHermesConfig
	}
	physical, err := filepath.EvalSymlinks(c.Home)
	if err != nil || physical != c.Home {
		return ErrHermesConfig
	}
	for _, p := range []string{c.Home, filepath.Join(c.Home, ".hermes"), filepath.Join(c.Home, "tmp"), filepath.Join(c.Home, ".hermes", "config.yaml")} {
		s, err := os.Lstat(p)
		if err != nil {
			return ErrHermesConfig
		}
		st, ok := s.Sys().(*syscall.Stat_t)
		if !ok || int(st.Uid) != os.Geteuid() || s.Mode()&os.ModeSymlink != 0 || s.Mode().Perm()&0077 != 0 {
			return ErrHermesConfig
		}
		if p == filepath.Join(c.Home, ".hermes", "config.yaml") {
			if !s.Mode().IsRegular() || st.Nlink != 1 || s.Size() == 0 || s.Size() > MaxWorker {
				return ErrHermesConfig
			}
		} else if !s.IsDir() {
			return ErrHermesConfig
		}
	}
	if s, err := os.Stat(c.Executable); err != nil || !s.Mode().IsRegular() || s.Mode().Perm()&0111 == 0 {
		return ErrHermesConfig
	}
	return nil
}

func readHermesInput(ctx context.Context, in *os.File) ([]byte, error) {
	if in == nil {
		return nil, ErrHermesInput
	}
	s, err := in.Stat()
	if err != nil {
		return nil, ErrHermesInput
	}
	if s.Mode()&os.ModeNamedPipe != 0 {
		reader, err := registeredPipe(in)
		if err != nil {
			return nil, ErrHermesInput
		}
		defer reader.Close()
		in = reader
		until := time.Now().Add(5 * time.Second)
		if d, ok := ctx.Deadline(); ok && d.Before(until) {
			until = d
		}
		if in.SetReadDeadline(until) != nil {
			return nil, ErrHermesInput
		}
	} else if !s.Mode().IsRegular() || s.Size() > MaxWorker {
		return nil, ErrHermesInput
	}
	raw, err := io.ReadAll(io.LimitReader(in, MaxWorker+1))
	if err != nil || len(raw) > MaxWorker || ctx.Err() != nil {
		return nil, ErrHermesInput
	}
	return raw, nil
}
