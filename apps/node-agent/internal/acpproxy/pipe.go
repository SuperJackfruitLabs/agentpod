// Package acpproxy carries ACP frames between an editor's stdio and the hub.
//
// It deliberately understands nothing about ACP. Every protocol decision —
// initialize, capabilities, session/load replay, permission round-trips,
// version negotiation — happens in the hub, where the TypeScript SDK is. This
// package moves bytes.
//
// That split is the whole design. `apn` is Go with two dependencies and has
// never parsed an ACP frame; putting the protocol here would mean maintaining a
// second implementation of a spec we do not control, in a language with no SDK,
// while that spec moves to v2. See
// docs/superpowers/specs/2026-08-11-doors-acp-proxy-design.md.
package acpproxy

import (
	"context"
	"io"
)

// Pipe copies in→sock and sock→out until either direction ends, or ctx is done.
//
// The first direction to finish ends the call. An editor that exits closes
// stdin; a hub that drops the session closes the socket. Either way the process
// should exit rather than linger holding a session open — an abandoned editor
// must not leave a live agent on someone's machine.
//
// Both copies are transparent: no framing, no parsing, no buffering by line. A
// frame this function cannot understand is a frame it does not need to.
func Pipe(ctx context.Context, sock io.ReadWriter, in io.Reader, out io.Writer) error {
	errc := make(chan error, 2)

	go func() {
		_, err := io.Copy(sock, in) // editor → hub
		errc <- err
	}()
	go func() {
		_, err := io.Copy(out, sock) // hub → editor
		errc <- err
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
