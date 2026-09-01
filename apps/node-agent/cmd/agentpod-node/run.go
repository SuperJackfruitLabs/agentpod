package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/acp"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/terminal"
)

func runCmd() {
	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
		fmt.Fprintln(os.Stderr, "not enrolled; run `agentpod-node enroll` first:", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	fmt.Println("connecting to", cfg.Hub, "as", cfg.NodeID)

	reg := buildRegistry(cfg)
	mgr := terminal.NewManager()
	defer mgr.Shutdown()
	acpMgr := acp.NewManager()
	defer acpMgr.Shutdown()

	resolver := gateway.WorkspaceFunc(func(key string) (string, error) {
		d, err := reg.For(key)
		if err != nil {
			return "", err
		}
		stations, err := d.Detect()
		if err != nil {
			return "", fmt.Errorf("workspace resolver: detect: %w", err)
		}
		for _, s := range stations {
			if s.Key == key && s.WorkspacePath != nil {
				return *s.WorkspacePath, nil
			}
		}
		return "", fmt.Errorf("workspace resolver: no workspacePath for key %q", key)
	})

	// lifecycleFn resolves the descriptor for key, checks it implements Lifecycle,
	// then performs stop/start/restart as requested.
	lifecycleFn := gateway.LifecycleFunc(func(key, action string) error {
		d, err := reg.For(key)
		if err != nil {
			return err
		}
		lc, ok := d.(descriptor.Lifecycle)
		if !ok {
			return fmt.Errorf("lifecycle: descriptor for %q does not support lifecycle", key)
		}
		switch action {
		case "stop":
			return lc.Stop(key)
		case "start":
			return lc.Start(key)
		case "restart":
			if err := lc.Stop(key); err != nil {
				return err
			}
			return lc.Start(key)
		default:
			return fmt.Errorf("lifecycle: unknown action %q", action)
		}
	})

	h := gateway.NewTerminalHandler(descriptor.NewHandler(reg), resolver, mgr, lifecycleFn)
	h = gateway.NewMatrixAdoptHandler(
		h,
		resolver,
		func(key string) (string, error) {
			d, err := reg.For(key)
			if err != nil {
				return "", err
			}
			return d.Harness(), nil
		},
		gateway.WriterLookupFunc(func(harness string) (gateway.ProfileWriteFunc, bool) {
			w, ok := descriptor.WriterFor(harness)
			if !ok {
				return nil, false
			}
			return w.Write, true
		}),
		gateway.NewHTTPCredentialFetcher(cfg.Hub, cfg.NodeID, cfg.NodeSecret),
		func(key string) error { return lifecycleFn(key, "restart") },
	)
	h = gateway.NewChangesetHandler(h, resolver)
	h = gateway.NewPostureHandler(h, func() int { return len(reg.DetectAll()) })
	h = gateway.NewACPHandler(h, acpMgr, descriptor.NewCapabilityHandler(reg).ACPCommand)
	h = gateway.NewUpdateHandler(h, version)
	gateway.Run(ctx, cfg, h, version, func() []gateway.HealthReport {
		return gatherHealthReports(reg)
	})
}

// gatherHealthReports enumerates all detected stations and collects a
// point-in-time health snapshot for each one. Called by the gateway health
// ticker (~30 s).
//
// The station list is detected ONCE and each station is then passed whole to
// descriptor.HealthOf. Resolving health by key instead (d.Health(s.Key)) makes
// every station re-run its descriptor's Detect, so a sweep of N stations costs
// N+N² host scans — 702 git processes per tick on a 26-project host, which is
// what pinned a real node's CPU. See descriptor.HealthForStation.
func gatherHealthReports(reg *descriptor.Registry) []gateway.HealthReport {
	stations := reg.DetectAll()
	reports := make([]gateway.HealthReport, 0, len(stations))
	for _, s := range stations {
		d, err := reg.For(s.Key)
		if err != nil {
			reports = append(reports, gateway.HealthReport{Key: s.Key, OK: false})
			continue
		}
		h, err := descriptor.HealthOf(d, s)
		if err != nil {
			reports = append(reports, gateway.HealthReport{Key: s.Key, OK: false})
			continue
		}
		reports = append(reports, gateway.HealthReport{
			Key:       s.Key,
			OK:        true,
			Running:   h.Running,
			PID:       h.PID,
			CPUPct:    h.CpuPct,
			MemBytes:  h.MemBytes,
			UptimeSec: h.UptimeSec,
		})
	}
	return reports
}
