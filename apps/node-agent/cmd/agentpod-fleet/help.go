package main

// helpRequested reports whether args' first element is a help flag. Only the
// first argument is checked, matching the flag package's own behaviour of
// treating a later "-h" as an ordinary value.
func helpRequested(args []string) bool {
	return len(args) > 0 && (args[0] == "-h" || args[0] == "--help")
}
