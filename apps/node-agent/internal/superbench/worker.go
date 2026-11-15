package superbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const MaxWorker = 64 << 10
const WorkerVersion = "agentpod.superbench-worker.v1"

type Binding struct {
	BoardID string `json:"board_id"`
	CardID  string `json:"card_id"`
	RunID   string `json:"run_id"`
	Epoch   uint64 `json:"epoch"`
}
type WorkerSpec struct {
	Version        string            `json:"version"`
	Binding        Binding           `json:"binding"`
	Directory      string            `json:"directory"`
	Arguments      []string          `json:"arguments"`
	Prompt         string            `json:"prompt"`
	Environment    map[string]string `json:"environment"`
	TimeoutSeconds uint32            `json:"timeout_seconds"`
}
type WorkerResult struct {
	Version string            `json:"version"`
	Binding Binding           `json:"binding"`
	Outcome string            `json:"outcome"`
	Handoff map[string]string `json:"handoff"`
}

func (b Binding) valid() bool {
	return b.BoardID != "" && b.CardID != "" && b.RunID != "" && b.Epoch > 0 && len(b.BoardID) <= 200 && len(b.CardID) <= 200 && len(b.RunID) <= 200
}

// PrepareWorker creates one private, non-reusable request directory. The spec
// carries task data only: never board tokens, station MCP config or lease tokens.
// 0700 is private storage for trusted commands, not same-UID isolation.
func PrepareWorker(parent string, spec WorkerSpec) (string, error) {
	if err := validateSpec(spec); err != nil {
		return "", err
	}
	if !filepath.IsAbs(parent) {
		return "", errors.New("private absolute context parent required")
	}
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return "", errors.New("private physical context parent required")
	}
	actual, err := filepath.EvalSymlinks(parent)
	if err != nil || actual != parent {
		return "", errors.New("symlink context parent refused")
	}
	raw, err := json.Marshal(spec)
	if err != nil || len(raw) > MaxWorker {
		return "", errors.New("worker request too large")
	}
	dir, err := os.MkdirTemp(parent, "superbench-worker-")
	if err != nil {
		return "", err
	}
	if err = writePrivate(filepath.Join(dir, "request.json"), raw); err != nil {
		return "", err
	}
	if err = syncDirectory(dir); err != nil {
		return "", err
	}
	if err = syncDirectory(parent); err != nil {
		return "", err
	}
	return dir, nil
}
func validateSpec(s WorkerSpec) error {
	if s.Version != WorkerVersion || !s.Binding.valid() || !filepath.IsAbs(s.Directory) || filepath.Clean(s.Directory) != s.Directory || len(s.Arguments) == 0 || len(s.Arguments) > 128 || !filepath.IsAbs(s.Arguments[0]) || s.TimeoutSeconds == 0 || s.TimeoutSeconds > 3600 {
		return errors.New("invalid worker specification")
	}
	for _, a := range s.Arguments {
		if strings.ContainsRune(a, 0) || len(a) > 8192 {
			return errors.New("invalid worker argument")
		}
	}
	for k, v := range s.Environment {
		switch k {
		case "PATH", "LANG", "LC_ALL", "TZ", "TERM":
		default:
			return errors.New("worker environment key refused")
		}
		if strings.ContainsAny(v, "\x00\r\n") {
			return errors.New("invalid worker environment")
		}
	}
	return nil
}
func childEnvironment(s WorkerSpec, dir string) []string {
	env := []string{"HOME=" + filepath.Join(dir, "home"), "XDG_CONFIG_HOME=" + filepath.Join(dir, "home", "config"), "XDG_CACHE_HOME=" + filepath.Join(dir, "home", "cache"), "XDG_DATA_HOME=" + filepath.Join(dir, "home", "data"), "TMPDIR=" + filepath.Join(dir, "tmp"), "PATH=/usr/bin:/bin", "GIT_TERMINAL_PROMPT=0"}
	for k, v := range s.Environment {
		env = append(env, k+"="+v)
	}
	return env
}

// ExecuteWorker is the one-shot executable body, launched BY benchd.run. It
// starts no independent daemon and does not acquire/release ownership itself.
// The inherited service environment is never forwarded to the actual harness.
// Board settlement must wait for benchd's later fence/checkpoint/release result.
func ExecuteWorker(ctx context.Context, dir string) error {
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("invalid private worker directory")
	}
	actual, err := filepath.EvalSymlinks(dir)
	if err != nil || actual != dir {
		return errors.New("nonphysical worker directory")
	}
	request, err := readPrivate(filepath.Join(dir, "request.json"))
	if err != nil {
		return err
	}
	var spec WorkerSpec
	if err = strictWorkerJSON(request, &spec); err != nil {
		return err
	}
	if err = validateSpec(spec); err != nil {
		return err
	}
	// Exclusive start marker prevents replaying an uncertain request as new work.
	started, err := os.OpenFile(filepath.Join(dir, "started"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("worker already started; inspect retained outcome")
	}
	if err = started.Sync(); err != nil {
		_ = started.Close()
		return err
	}
	if err = started.Close(); err != nil {
		return err
	}
	if err = syncDirectory(dir); err != nil {
		return err
	}
	for _, name := range []string{"home", "tmp"} {
		if err = os.Mkdir(filepath.Join(dir, name), 0700); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(spec.TimeoutSeconds)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, spec.Arguments[0], spec.Arguments[1:]...)
	cmd.Dir = spec.Directory
	cmd.Env = childEnvironment(spec, dir)
	cmd.WaitDelay = 2 * time.Second
	prompt, _ := json.Marshal(struct {
		Binding Binding `json:"binding"`
		Prompt  string  `json:"prompt"`
	}{spec.Binding, spec.Prompt})
	cmd.Stdin = bytes.NewReader(prompt)
	capture := &boundedBuffer{}
	cmd.Stdout = capture
	cmd.Stderr = io.Discard
	if err = cmd.Run(); err != nil {
		return errors.New("harness failed; retained context requires inspection")
	}
	raw, overflow := capture.read()
	if overflow {
		return errors.New("harness result exceeds bound")
	}
	var result WorkerResult
	if err = strictWorkerJSON(raw, &result); err != nil {
		return err
	}
	if result.Version != WorkerVersion || result.Binding != spec.Binding || result.Handoff == nil || (result.Outcome != "complete" && result.Outcome != "blocked" && result.Outcome != "failed") {
		return errors.New("invalid bound harness result")
	}
	f, err := os.OpenFile(filepath.Join(dir, "result.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return syncDirectory(dir)
}

// ReadWorkerResult is evidence only, never proof of a stopped writer or release.
func ReadWorkerResult(dir string, binding Binding) (WorkerResult, error) {
	var r WorkerResult
	raw, e := readPrivate(filepath.Join(dir, "result.json"))
	if e != nil {
		return r, e
	}
	if e = strictWorkerJSON(raw, &r); e != nil {
		return r, e
	}
	if r.Binding != binding || r.Version != WorkerVersion || r.Handoff == nil || (r.Outcome != "complete" && r.Outcome != "blocked" && r.Outcome != "failed") {
		return r, errors.New("invalid worker result")
	}
	return r, nil
}
func readPrivate(path string) ([]byte, error) {
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > MaxWorker {
		return nil, errors.New("invalid private worker file")
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	raw, e := io.ReadAll(io.LimitReader(f, MaxWorker+1))
	if e != nil || len(raw) > MaxWorker {
		return nil, errors.New("worker file exceeds bound")
	}
	return raw, nil
}
func strictWorkerJSON(raw []byte, out any) error {
	if len(raw) > MaxWorker {
		return errors.New("worker JSON exceeds bound")
	}
	if err := strictJSON(raw, out); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	return d.Decode(out)
}

type boundedBuffer struct {
	mu       sync.Mutex
	raw      []byte
	overflow bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remain := MaxWorker - len(b.raw)
	if n > remain {
		b.overflow = true
		p = p[:remain]
	}
	b.raw = append(b.raw, p...)
	return n, nil
}
func (b *boundedBuffer) read() ([]byte, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.raw, b.overflow
}

func syncDirectory(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
func writePrivate(path string, raw []byte) error {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = f.Write(raw); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	return closeErr
}
