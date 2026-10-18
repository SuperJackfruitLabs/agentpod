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
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return fmt.Errorf("want a non-negative integer, got %q", s)
	}
	*u = append(*u, n)
	return nil
}

// forgeAPIDeps are the seams the tests replace.
type forgeAPIDeps struct {
	newClient func(binary, serviceUser string) stkclient.Client
	setup     func(ctx context.Context, c stkclient.Client, o forgeapi.SetupOptions) (forgeapi.SetupResult, error)
	harness   func() []int
}

func defaultForgeAPIDeps() forgeAPIDeps {
	return forgeAPIDeps{newClient: newStkClient, setup: forgeapi.Setup, harness: forgeapi.CLIHarnessUIDs}
}

// newStkClient builds the stk client for this node. When the node is root and
// the service user already exists, stk commands run as that user (the store
// belongs to it); before install there is no such user and stk runs directly.
func newStkClient(binary, serviceUser string) stkclient.Client {
	var opts stkclient.Options
	if os.Geteuid() == 0 && serviceUser != "" {
		if _, err := user.Lookup(serviceUser); err == nil {
			opts.RunAs = serviceUser
		}
	}
	if binary == "" {
		binary = "stk"
	}
	return stkclient.New(binary, opts)
}

// newStationEnsurer is the lazy seam run.go hands to the forge.api deliver
// handler. Nothing runs stk until the first Ensure call.
func newStationEnsurer() *forgeapi.Ensurer {
	return forgeapi.NewEnsurer(newStkClient("stk", "stk"), forgeapi.SetupOptions{})
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
	res, err := d.setup(ctx, d.newClient(*bin, *svcUser), forgeapi.SetupOptions{
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
