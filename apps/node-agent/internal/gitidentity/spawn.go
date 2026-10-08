package gitidentity

import "strings"

// CommandFunc is the shape of `descriptor.Handler.ACPCommand`: the argv, working directory and
// extra environment a station's harness is started with.
type CommandFunc func(key string) (argv []string, dir string, env []string, err error)

// WithSSHCommand puts a station's push key — and, when the hub has sent one, its commit author —
// into the environment of the harness it starts. See Env for exactly what.
//
// This is the step that makes a provisioned key do anything. A key on disk and an account on forge
// are inert until the process doing the pushing knows to use them, and `GIT_SSH_COMMAND` is how
// that is said without touching any repository's config — so it covers every repo the agent clones,
// including ones that did not exist when the key was provisioned.
//
// A station with no identity is left exactly as it was: no variable, no error, nothing logged.
// That is the common case, and a harness that suddenly carried a GIT_SSH_COMMAND naming a missing
// file would fail every push with an ssh error that names nothing useful.
func WithSSHCommand(root string, inner CommandFunc) CommandFunc {
	return func(key string) ([]string, string, []string, error) {
		argv, dir, env, err := inner(key)
		if err != nil {
			return argv, dir, env, err
		}
		return argv, dir, MergeEnv(env, Env(root, key)), nil
	}
}

// MergeEnv adds extra to env, skipping any variable env already sets. The result is appended to
// os.Environ() by the spawner, where the LAST duplicate wins — so a plain append would override a
// value the descriptor chose for its own harness, which knows things this package does not.
func MergeEnv(env, extra []string) []string {
	set := make(map[string]bool, len(env))
	for _, e := range env {
		set[strings.SplitN(e, "=", 2)[0]] = true
	}
	for _, e := range extra {
		if !set[strings.SplitN(e, "=", 2)[0]] {
			env = append(env, e)
		}
	}
	return env
}
