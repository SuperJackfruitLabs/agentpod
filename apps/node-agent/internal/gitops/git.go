package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// GitTimeout bounds every git invocation. A huge repository or a stalled
// network mount must not pin a gateway handler goroutine forever.
const GitTimeout = 20 * time.Second

// ErrNotARepo is returned when a station's workspace is not a git repository.
var ErrNotARepo = errors.New("workspace is not a git repository")

// gitEnv builds the environment for every git call.
//
// GIT_OPTIONAL_LOCKS=0 is the important one: `git status` otherwise takes the
// index lock in order to refresh it, and these are workspaces with agents
// actively editing files. Our read would intermittently contend with the
// agent's own git operations.
//
// GIT_TERMINAL_PROMPT=0 and the askpass settings keep git from ever waiting on
// input we cannot supply.
func gitEnv() []string {
	return append(os.Environ(),
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
		"GCM_INTERACTIVE=never",
		"LC_ALL=C",
	)
}

// run executes git in dir and returns stdout.
//
// argv only — never a shell string. Everything this package runs is read-only
// plumbing: no `git add`, no `git add -N`, no config writes. The repository is
// never mutated.
func run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, _, err := runCode(ctx, dir, args...)
	return out, err
}

// runAllowExit1 is run for commands where exit code 1 is a normal result rather
// than a failure — `git diff --no-index` exits 1 whenever the files differ.
func runAllowExit1(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, code, err := runCode(ctx, dir, args...)
	if err != nil && code == 1 {
		return out, nil
	}
	return out, err
}

func runCode(ctx context.Context, dir string, args ...string) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, GitTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	// ProcessState is nil when the process never started (e.g. a context that
	// was already cancelled), so it cannot be dereferenced unconditionally.
	code := -1
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}

	if err != nil {
		if ctx.Err() != nil {
			return stdout.Bytes(), code, fmt.Errorf("git %s: %w", args[0], ctx.Err())
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.Bytes(), code, fmt.Errorf("git %s: %s", args[0], msg)
	}
	return stdout.Bytes(), code, nil
}

// IsRepo reports whether dir sits inside a git work tree and git is usable.
//
// Used to decide whether a station advertises the changeset capability at all,
// so it answers false rather than erroring for every reason it might fail.
func IsRepo(ctx context.Context, dir string) bool {
	if dir == "" {
		return false
	}
	if _, err := exec.LookPath("git"); err != nil {
		return false
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return false
	}
	out, err := run(ctx, dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(string(out)) == "true"
}
