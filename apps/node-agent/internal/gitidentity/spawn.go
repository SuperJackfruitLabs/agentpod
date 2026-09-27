package gitidentity

// CommandFunc is the shape of `descriptor.Handler.ACPCommand`: the argv, working directory and
// extra environment a station's harness is started with.
type CommandFunc func(key string) (argv []string, dir string, env []string, err error)

// WithSSHCommand puts a station's push key into the environment of the harness it starts.
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
		keyPath, ok := KeyPathForStationKey(root, key)
		if !ok {
			return argv, dir, env, nil
		}
		// Appended, so an env already carrying GIT_SSH_COMMAND for its own reasons wins — the
		// descriptor knows things about its harness that this does not.
		return argv, dir, append(env, "GIT_SSH_COMMAND="+SSHCommand(keyPath)), nil
	}
}
