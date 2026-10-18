package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"strconv"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// uidList collects repeated --agent-uid flags.
type uidList []int

func (u *uidList) String() string { return fmt.Sprint([]int(*u)) }
func (u *uidList) Set(s string) error {
	n, err := strconv.ParseUint(s, 10, 32)
	if err != nil {
		return fmt.Errorf("want a uid between 0 and 4294967295, got %q", s)
	}
	*u = append(*u, int(n))
	return nil
}

// forgeAPIDeps are the seams the tests replace.
type forgeAPIDeps struct {
	newClient func(binary, serviceUser, stateDir string) stkclient.Client
	setup     func(ctx context.Context, newClient func() stkclient.Client, o forgeapi.SetupOptions) (forgeapi.SetupResult, error)
	harness   func() []int
}

func defaultForgeAPIDeps() forgeAPIDeps {
	return forgeAPIDeps{newClient: newStkClient, setup: forgeapi.Setup, harness: forgeapi.CLIHarnessUIDs}
}

// defaultStkStateDir is where `stk install` puts the store unless told otherwise.
const defaultStkStateDir = "/var/lib/stk"

// stkOptions decides how the node runs stk. The store belongs to the service
// user, so when the node is root and that user exists, stk runs as it, with
// STK_HOME pointing at the service's state directory (stk would otherwise look
// in the caller's own config dir and inspect a different store than the one
// `stk install` writes). An explicit stateDir is always honoured.
func stkOptions(euid int, userExists func(string) bool, serviceUser, stateDir string) stkclient.Options {
	var opts stkclient.Options
	serviceExists := euid == 0 && serviceUser != "" && userExists(serviceUser)
	if serviceExists {
		opts.RunAs = serviceUser
	}
	switch {
	case stateDir != "":
		opts.Env = map[string]string{"STK_HOME": stateDir}
	case serviceExists:
		opts.Env = map[string]string{"STK_HOME": defaultStkStateDir}
	}
	return opts
}

func osUserExists(name string) bool { _, err := user.Lookup(name); return err == nil }

// newStkClient builds a client reflecting the machine as it is now; callers
// invoke it again after an install so the user that now exists is used.
func newStkClient(binary, serviceUser, stateDir string) stkclient.Client {
	if binary == "" {
		binary = "stk"
	}
	return stkclient.New(binary, stkOptions(os.Geteuid(), osUserExists, serviceUser, stateDir))
}

// newStationEnsurer is the lazy seam run.go hands to the forge.api deliver
// handler. Nothing runs stk until the first Ensure call.
func newStationEnsurer() *forgeapi.Ensurer {
	return forgeapi.NewEnsurer(func() stkclient.Client { return newStkClient("stk", "stk", "") }, forgeapi.SetupOptions{})
}

// newForgeAPIService wires the forge.api verbs to the real stk. STK_CONFIG, when set, names the
// policy file (it is the variable stk itself reads); otherwise stk's install default is used.
func newForgeAPIService(ensure func(context.Context) (forgeapi.SetupResult, error)) *forgeapi.Service {
	path := os.Getenv("STK_CONFIG")
	if path == "" {
		path = forgeapi.DefaultPolicyPath
	}
	return &forgeapi.Service{
		Ensure:     ensure,
		NewClient:  func() stkclient.Client { return newStkClient("stk", "stk", "") },
		PolicyPath: path,
	}
}

func forgeAPICmd(args []string, out, errw io.Writer) int {
	return forgeAPICmdWith(args, out, errw, defaultForgeAPIDeps())
}

func forgeAPICmdWith(args []string, out, errw io.Writer, d forgeAPIDeps) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintln(out, commandHelp("forge-api"))
		return 0
	}
	if args[0] != "setup" {
		fmt.Fprintf(errw, "forge-api: unknown verb %q (try: setup)\n", args[0])
		return 2
	}
	fs := flag.NewFlagSet("forge-api setup", flag.ContinueOnError)
	fs.SetOutput(errw)
	fs.Usage = func() {
		fmt.Fprintln(errw, commandHelp("forge-api"))
		fs.PrintDefaults()
	}
	svcUser := fs.String("user", "stk", "OS user stk runs as")
	stateDir := fs.String("state-dir", "", "stk state directory (default: stk's own)")
	bin := fs.String("stk", "stk", "path to the stk binary")
	var uids uidList
	fs.Var(&uids, "agent-uid", "uid allowed to use the broker (repeatable; default: the uid harnesses run as)")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	res, err := d.setup(ctx, func() stkclient.Client { return d.newClient(*bin, *svcUser, *stateDir) }, forgeapi.SetupOptions{
		StkBinary: *bin, ServiceUser: *svcUser, AgentUIDs: uids, StateDir: *stateDir, Interactive: true,
	})
	if res.Report.Isolation.Level != "" {
		forgeapi.WriteSummary(out, res)
	}
	if err != nil {
		fmt.Fprintf(errw, "forge-api setup: %v\n", err)
		return 1
	}
	return 0
}
