package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
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
	// station creates one station's own instance (`setup --station`).
	station func(ctx context.Context, stationID string, uids []int, allowSharedUID bool) (forgeapi.SetupResult, forgeapi.Instance, error)
	// prune removes one station's instance by hand (`forge-api prune`).
	prune func(ctx context.Context, stationID string, dryRun bool) (forgeapi.Instance, bool, error)
}

func defaultForgeAPIDeps() forgeAPIDeps {
	return forgeAPIDeps{newClient: newStkClient, setup: forgeapi.Setup, harness: forgeapi.CLIHarnessUIDs, station: setupStation, prune: pruneStation}
}

// pruneStation is `forge-api prune`.
func pruneStation(ctx context.Context, stationID string, dryRun bool) (forgeapi.Instance, bool, error) {
	var c config.Config
	if loaded, err := config.Load(config.DefaultPath()); err == nil {
		c = loaded
	}
	var fc config.ForgeAPI
	if c.ForgeAPI != nil {
		fc = *c.ForgeAPI
	}
	cfg, err := forgeAPIInstancesConfig(fc, os.Getenv)
	if err != nil {
		return forgeapi.Instance{}, false, err
	}
	m, err := forgeapi.NewStationInstances(cfg)
	if err != nil {
		return forgeapi.Instance{}, false, err
	}
	return m.PruneStation(ctx, stationID, dryRun)
}

// setupStation is `forge-api setup --station`: it creates the station's instance the way the node
// would at its first deliver, with the same names, port and registry.
func setupStation(ctx context.Context, stationID string, uids []int, allowSharedUID bool) (forgeapi.SetupResult, forgeapi.Instance, error) {
	var c config.Config
	if loaded, err := config.Load(config.DefaultPath()); err == nil {
		c = loaded
	}
	var fc config.ForgeAPI
	if c.ForgeAPI != nil {
		fc = *c.ForgeAPI
	}
	cfg, err := forgeAPIInstancesConfig(fc, os.Getenv)
	if err != nil {
		return forgeapi.SetupResult{}, forgeapi.Instance{}, err
	}
	if len(uids) > 0 {
		cfg.AgentUIDs = func(string) []int { return uids }
	} else if len(fc.StationUIDs) == 0 {
		cfg.AgentUIDs = func(string) []int { return forgeapi.CLIHarnessUIDs() }
	}
	cfg.AllowSharedAgentUID = cfg.AllowSharedAgentUID || allowSharedUID
	m, err := forgeapi.NewStationInstances(cfg)
	if err != nil {
		return forgeapi.SetupResult{}, forgeapi.Instance{}, err
	}
	return m.Ensure(ctx, stationID)
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

// instanceClientOptions decides how the node runs the stk of one station's instance. Its store
// belongs to the instance's own user, so a root node runs stk as that user with the instance's
// STK_HOME, STK_CONFIG and STK_SOCKET (the same values the unit sets). Until the user exists
// there is no instance to speak to: no RunAs and no environment, so nothing is created as root
// by a stray stk call.
func instanceClientOptions(euid int, userExists func(string) bool, inst forgeapi.Instance) stkclient.Options {
	var opts stkclient.Options
	if euid == 0 && userExists(inst.User()) {
		opts.RunAs = inst.User()
		opts.Env = map[string]string{
			"STK_HOME": inst.StateDir, "STK_CONFIG": inst.ConfigPath, "STK_SOCKET": inst.SocketPath(),
		}
	}
	return opts
}

// newInstanceClient builds a client for one station's instance as the machine is now.
func newInstanceClient(inst forgeapi.Instance) stkclient.Client {
	return stkclient.New("stk", instanceClientOptions(os.Geteuid(), osUserExists, inst))
}

// nodeHarnessWiring is how the node reaches the systemd user units that start a station's harness:
// which units a station key has, whether one is running, the drop-in directory and a daemon-reload.
// The env files themselves are written by forgeapi, owned by the station's agent uid.
func nodeHarnessWiring() *forgeapi.HarnessWiring {
	return &forgeapi.HarnessWiring{
		Units:        descriptor.HarnessSystemdUnits,
		DropInDir:    descriptor.UserUnitDropInDir,
		Running:      func(_ context.Context, unit string) bool { return descriptor.UserUnitActive(unit) },
		DaemonReload: func(context.Context) error { return descriptor.UserDaemonReload() },
		UnitEnv:      func(_ context.Context, unit string) []string { return descriptor.UserUnitEnvironment(unit) },
	}
}

// forgeAPIInstancesConfig turns node config and environment into the instances configuration.
// Environment wins over the config file, which wins over the defaults.
func forgeAPIInstancesConfig(c config.ForgeAPI, getenv func(string) string) (forgeapi.InstancesConfig, error) {
	cfg := forgeapi.InstancesConfig{
		RegistryPath: c.Registry, SharedPolicyPath: c.SharedPolicy, PortMin: c.ProxyPortMin, PortMax: c.ProxyPortMax,
		NewClient: newInstanceClient, AllowSharedAgentUID: c.AllowSharedAgentUID,
		// The node spawns ACP sessions and terminals as itself, so "spawn" is never known to run
		// as another uid. A long-lived gateway unit (a per-profile Hermes user unit) runs as the
		// uid the operator mapped the station to, which the node cannot read back from systemd.
		HarnessRunsAs: func(station, path string) (int, bool) {
			if u := c.StationUIDs[station]; path == "gateway" && len(u) > 0 && u[0] != os.Geteuid() {
				return u[0], true
			}
			return 0, false
		},
		AgentUIDs: func(station string) []int {
			if u := c.StationUIDs[station]; len(u) > 0 {
				return u
			}
			return forgeapi.NodeHarnessUIDs()
		},
		Harness:   nodeHarnessWiring(),
		Lifecycle: &forgeapi.SystemLifecycle{Roots: []string{forgeapi.DefaultStateRoot, forgeapi.DefaultConfigRoot, forgeapi.DefaultRuntimeRoot}},
	}
	if v := strings.ToLower(strings.TrimSpace(getenv("AGENTPOD_ALLOW_SHARED_AGENT_UID"))); v == "1" || v == "true" || v == "yes" {
		cfg.AllowSharedAgentUID = true
	}
	if v := getenv("AGENTPOD_STK_REGISTRY"); v != "" {
		cfg.RegistryPath = v
	}
	if v := getenv("AGENTPOD_STK_SHARED_POLICY"); v != "" {
		cfg.SharedPolicyPath = v
	}
	if v := getenv("AGENTPOD_STK_PORTS"); v != "" {
		lo, hi, ok := strings.Cut(v, "-")
		min, err1 := strconv.Atoi(strings.TrimSpace(lo))
		max, err2 := strconv.Atoi(strings.TrimSpace(hi))
		if !ok || err1 != nil || err2 != nil {
			return cfg, fmt.Errorf("AGENTPOD_STK_PORTS=%q: want MIN-MAX, for example 8900-8999", v)
		}
		cfg.PortMin, cfg.PortMax = min, max
	}
	return cfg, nil
}

// newStationInstances is what run.go hands to the forge.api handler. Nothing runs stk, reads the
// registry or touches the host until the first frame for a station.
func newStationInstances(c config.Config, getenv func(string) string, hosted func(key string) bool) (*forgeapi.StationInstances, error) {
	var fc config.ForgeAPI
	if c.ForgeAPI != nil {
		fc = *c.ForgeAPI
	}
	cfg, err := forgeAPIInstancesConfig(fc, getenv)
	if err != nil {
		return nil, err
	}
	cfg.Hosted = hosted
	return forgeapi.NewStationInstances(cfg)
}

// forgeAPIForNode builds forge API access for `apn run`. A bad forge-api setting (an unparseable
// port range, an inverted one) must not stop the node: the cause is logged once, enabled is false
// (the node does not advertise `forge.api`) and the verbs answer `stk-unavailable` with the cause.
// instances is nil then, and the spawn-path hooks that take it are nil-safe.
func forgeAPIForNode(c config.Config, getenv func(string) string, hosted func(key string) bool) (instances *forgeapi.StationInstances, api gateway.ForgeAPI, enabled bool) {
	inst, err := newStationInstances(c, getenv, hosted)
	if err != nil {
		log.Printf("forge.api: disabled, not advertised: %v", err)
		return nil, forgeapi.Unavailable{Cause: err}, false
	}
	return inst, inst, true
}

// detectedKey reports whether the node itself detects a station with this key.
func detectedKey(reg *descriptor.Registry) func(string) bool {
	return func(key string) bool {
		for _, s := range reg.DetectAll() {
			if s.Key == key {
				return true
			}
		}
		return false
	}
}

// newForgeAPIProbe is the capability probe: a client for the machine as it is now, 5s deadline.
// It never needs root (a non-root node runs stk directly) and never installs.
func newForgeAPIProbe() *forgeapi.CapabilityProbe {
	return forgeapi.NewCapabilityProbe(func() stkclient.Client { return newStkClient("stk", "stk", "") }, forgeapi.DefaultProbeTimeout)
}

// forgeAPIPrune is `apn forge-api prune --station ID [--dry-run] [--yes]`: it removes ONE
// registered station's whole stk instance (unit, user, state, policy, the harness wiring), by hand.
// Nothing prunes automatically. A station the node's registry does not list is left alone.
func forgeAPIPrune(args []string, out, errw io.Writer, d forgeAPIDeps) int {
	fs := flag.NewFlagSet("forge-api prune", flag.ContinueOnError)
	fs.SetOutput(errw)
	station := fs.String("station", "", "the station whose stk instance to remove")
	dry := fs.Bool("dry-run", false, "say what would be removed and remove nothing")
	yes := fs.Bool("yes", false, "confirm: remove the instance, its stored credentials and its harness wiring")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if *station == "" {
		fmt.Fprintln(errw, "forge-api prune: --station is required")
		return 2
	}
	if !*dry && !*yes {
		fmt.Fprintln(errw, "forge-api prune: this deletes the station's stk user, state and every credential it holds; pass --yes to do it, or --dry-run to see what it would remove")
		return 2
	}
	if d.prune == nil {
		fmt.Fprintln(errw, "forge-api prune: not available")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	inst, found, err := d.prune(ctx, *station, *dry)
	if !found && err == nil {
		fmt.Fprintf(out, "station %s has no stk instance in this node's registry; nothing to remove\n", *station)
		return 0
	}
	verb := "removed"
	if *dry {
		verb = "would remove"
	}
	if found {
		fmt.Fprintf(out, "%s instance %s (unit %s, user %s, state %s, config %s)\n", verb, inst.Name, inst.Unit(), inst.User(), inst.StateDir, filepath.Dir(inst.ConfigPath))
	}
	if err != nil {
		fmt.Fprintf(errw, "forge-api prune: %v\n", err)
		return 1
	}
	return 0
}

func forgeAPICmd(args []string, out, errw io.Writer) int {
	return forgeAPICmdWith(args, out, errw, defaultForgeAPIDeps())
}

func forgeAPICmdWith(args []string, out, errw io.Writer, d forgeAPIDeps) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintln(out, commandHelp("forge-api"))
		return 0
	}
	if args[0] == "prune" {
		return forgeAPIPrune(args[1:], out, errw, d)
	}
	if args[0] != "setup" {
		fmt.Fprintf(errw, "forge-api: unknown verb %q (try: setup, prune)\n", args[0])
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
	allowShared := fs.Bool("allow-shared-agent-uid", false, "acknowledge that stations sharing an agent uid are not isolated from each other")
	station := fs.String("station", "", "create this station's own stk instance (user, state, port, unit derived from the id)")
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
	if *station != "" {
		set := map[string]bool{}
		fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
		if set["user"] || set["state-dir"] || set["stk"] {
			fmt.Fprintln(errw, "forge-api setup: --station derives the user and state directory itself; do not combine it with --user, --state-dir or --stk")
			return 2
		}
		res, inst, err := d.station(ctx, *station, uids, *allowShared)
		if res.Report.Isolation.Level != "" {
			forgeapi.WriteSummary(out, res)
		}
		if inst.Name != "" {
			fmt.Fprintf(out, "instance:  %s (unit %s, proxy port %d)\n", inst.Name, inst.Unit(), inst.Port)
		}
		if err != nil {
			fmt.Fprintf(errw, "forge-api setup: %v\n", err)
			return 1
		}
		return 0
	}
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
