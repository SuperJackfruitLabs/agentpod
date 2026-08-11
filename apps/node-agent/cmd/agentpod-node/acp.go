package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/coder/websocket"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/acpproxy"
)

// acpCmd makes a station on another machine look like a local agent to any ACP
// client — Zed, JetBrains, anything that speaks the protocol.
//
// The editor spawns this process and talks ACP over its stdio. We pipe those
// bytes to the hub and back, parsing nothing: every protocol decision happens
// in the hub, where the SDK is. That is why `apn` needs no ACP library, no
// JSON-RPC, and no notion of a protocol version.
//
// This is the one `apn` subcommand that does not require an enrolled node. A
// laptop running an editor installs `apn` purely as a client.
func acpCmd(args []string) {
	fs := flag.NewFlagSet("acp", flag.ExitOnError)
	list := fs.Bool("list", false, "list the stations you can attach an editor to")
	station := fs.String("station", "", "station to attach to")
	session := fs.String("session", "", "specific session to resume")
	hub := fs.String("hub", envOr("AGENTPOD_HUB", "https://hub.agentpod.dev"), "hub base URL")
	token := fs.String("token", os.Getenv("AGENTPOD_TOKEN"), "hub token (prefer the AGENTPOD_TOKEN env var)")
	_ = fs.Parse(args)

	// Discovery first: someone who has never used this has no station id, and
	// telling them to go and find one in a web console is a poor answer for a
	// command line tool.
	if *list {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		stations, err := acpproxy.ListStations(ctx, *hub, *token)
		if err != nil {
			fmt.Fprintf(os.Stderr, "apn acp: %v\n", err)
			os.Exit(1)
		}
		fmt.Print(acpproxy.FormatStations(stations))
		return
	}

	if err := acpproxy.ValidateTarget(*station, *session); err != nil {
		fmt.Fprintf(os.Stderr, "apn acp: %v\n\nFind one with:\n  apn acp --list\n", err)
		os.Exit(2)
	}

	// Ctrl-C, or the editor being killed, must end the process rather than
	// leave a session live on the hub.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	conn, err := acpproxy.Dial(ctx, *hub, *token, *station, *session)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apn acp: %v\n", err)
		os.Exit(1)
	}
	defer conn.CloseNow()

	// NetConn turns the message-oriented socket into an io.ReadWriter, which is
	// all the pipe wants. MessageText because ACP is newline-delimited JSON.
	sock := websocket.NetConn(ctx, conn, websocket.MessageText)

	if err := acpproxy.Pipe(ctx, sock, os.Stdin, os.Stdout); err != nil {
		// EOF and cancellation are how this ends normally: the editor exited,
		// or someone pressed Ctrl-C.
		if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
			return
		}
		fmt.Fprintf(os.Stderr, "apn acp: %v\n", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
