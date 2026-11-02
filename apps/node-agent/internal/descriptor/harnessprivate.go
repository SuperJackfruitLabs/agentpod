package descriptor

// The four project harnesses use a project directory as the root, never their own home, unless a
// project is opened AT the home (cwd ~/.claude, ~/.pi/agent, ~/.local/share/opencode): then the
// whole root is the harness's private files and nothing in it is linkable.
func PrivateIfHome(root string, err error) []string {
	if err != nil || rootInDeniedTree(root) {
		return []string{"."}
	}
	return nil
}
