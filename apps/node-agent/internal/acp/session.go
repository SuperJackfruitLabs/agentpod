// Package acp provides a non-PTY stdio session manager for spawning harness
// ACP (Agent Client Protocol) processes. ACP speaks JSON-RPC over stdio, so
// the child is wired with plain pipes — a PTY would corrupt the framing.
package acp

import (
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// stdoutChunkBytes is the read-buffer size for the stdout streaming loop.
const stdoutChunkBytes = 32 * 1024

// subChanBuffer is the per-subscriber chunk buffer. A subscriber whose
// callback falls more than subChanBuffer chunks behind is dropped
// (unsubscribed) rather than allowed to stall the stdout read loop.
const subChanBuffer = 64

// stderrRingBytes is the maximum number of stderr bytes retained for exit
// reasons (last 4 KiB).
const stderrRingBytes = 4 * 1024

// closeGrace is how long Close waits after SIGTERM before escalating to
// SIGKILL.
const closeGrace = 3 * time.Second

// subscriber is one registered stdout consumer: a buffered chunk queue fed by
// the read loop and drained by a dedicated dispatcher goroutine.
type subscriber struct {
	ch   chan []byte
	quit chan struct{}
	stop sync.Once
}

// shutdown detaches the subscriber's dispatcher (idempotent).
func (sub *subscriber) shutdown() {
	sub.stop.Do(func() { close(sub.quit) })
}

// Session wraps a single ACP child process wired over plain stdio pipes.
// It is safe for concurrent use.
type Session struct {
	id    string
	cmd   *exec.Cmd
	stdin io.WriteCloser

	writeMu sync.Mutex // serializes Write so JSON-RPC frames never interleave

	mu         sync.Mutex
	subs       map[int]*subscriber
	subSeq     int
	stderrRing []byte
	exitFns    []func(reason string)
	exited     bool
	exitReason string
	stdinDone  bool

	closeOnce sync.Once
	done      chan struct{} // closed once the child has been reaped
}

// newSession spawns argv[0] with argv[1:] in dir with env appended to
// os.Environ(), and starts the stdout/stderr pump and reaper goroutines.
func newSession(id string, argv []string, dir string, env []string) (*Session, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	// Put the child in its own process group so Close can signal the whole
	// group (reaps grandchildren too). No PTY here, so Setpgid is safe.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	s := &Session{
		id:    id,
		cmd:   cmd,
		stdin: stdin,
		subs:  make(map[int]*subscriber),
		done:  make(chan struct{}),
	}

	// The pipe readers must drain before cmd.Wait() is called (Wait closes
	// the parent ends of the pipes).
	var readers sync.WaitGroup
	readers.Add(2)
	go s.stdoutLoop(stdout, &readers)
	go s.stderrLoop(stderr, &readers)
	go s.reap(&readers)
	return s, nil
}

// stdoutLoop streams child stdout to subscriber queues in chunks. Delivery is
// a non-blocking send to each subscriber's buffered channel — the read loop
// never blocks on a consumer. A subscriber whose queue overflows is dropped
// (unsubscribed) so a stalled consumer cannot wedge the session.
func (s *Session) stdoutLoop(r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()

	buf := make([]byte, stdoutChunkBytes)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			s.mu.Lock()
			for id, sub := range s.subs {
				select {
				case sub.ch <- chunk:
				default:
					// Slow consumer: drop the subscriber, not the stream.
					delete(s.subs, id)
					sub.shutdown()
					log.Printf("acp: session %s dropped slow subscriber (queue overflow)", s.id)
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}

	// Session output is over: detach all subscribers so their dispatcher
	// goroutines drain any buffered chunks and exit.
	s.mu.Lock()
	subs := s.subs
	s.subs = make(map[int]*subscriber)
	s.mu.Unlock()
	for _, sub := range subs {
		sub.shutdown()
	}
}

// dispatch delivers queued chunks to one subscriber's callback in order. On
// shutdown it drains whatever is already buffered, then exits. A callback
// that blocks forever pins only this goroutine — never the read loop.
func (s *Session) dispatch(sub *subscriber, fn func(chunk []byte)) {
	for {
		select {
		case c := <-sub.ch:
			fn(c)
		case <-sub.quit:
			for {
				select {
				case c := <-sub.ch:
					fn(c)
				default:
					return
				}
			}
		}
	}
}

// stderrLoop drains child stderr into a bounded ring (last stderrRingBytes).
func (s *Session) stderrLoop(r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()

	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			s.mu.Lock()
			s.stderrRing = append(s.stderrRing, buf[:n]...)
			if len(s.stderrRing) > stderrRingBytes {
				s.stderrRing = s.stderrRing[len(s.stderrRing)-stderrRingBytes:]
			}
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// reap waits for the pipe readers to drain, reaps the child, and fires the
// OnExit callbacks exactly once.
func (s *Session) reap(readers *sync.WaitGroup) {
	readers.Wait()
	err := s.cmd.Wait()

	reason := "exit"
	if err != nil {
		reason = err.Error()
		if tail := s.StderrTail(); tail != "" {
			reason += ": " + tail
		}
	}

	s.mu.Lock()
	s.exited = true
	s.exitReason = reason
	fns := s.exitFns
	s.exitFns = nil
	s.mu.Unlock()

	// Close done BEFORE firing callbacks: a callback may call s.Close(),
	// which blocks on done — firing first would deadlock forever.
	close(s.done)
	for _, fn := range fns {
		fn(reason)
	}
}

// ID returns the unique session identifier (e.g. "acp_1a2b3c4d").
func (s *Session) ID() string {
	return s.id
}

// Write sends p to the child's stdin. Concurrent calls are serialized, so
// each call's bytes reach the child contiguously — a JSON-RPC frame written
// in one call is never interleaved with another writer's frame.
func (s *Session) Write(p []byte) error {
	s.writeMu.Lock()
	_, err := s.stdin.Write(p)
	s.writeMu.Unlock()
	return err
}

// Subscribe registers fn to receive child stdout chunks and returns an
// unsubscribe function.
//
// Delivery contract (Task 4 relies on this): chunks are delivered in order by
// a dedicated per-subscriber goroutine feeding from a buffered queue of
// subChanBuffer chunks. The stdout read loop never blocks on a subscriber —
// if fn falls more than subChanBuffer chunks behind, the subscriber is
// DROPPED (auto-unsubscribed, logged) rather than allowed to stall the
// session or lose stream position for other subscribers. A dropped or
// unsubscribed consumer receives no further chunks after its buffered
// backlog drains.
func (s *Session) Subscribe(fn func(chunk []byte)) (unsub func()) {
	sub := &subscriber{
		ch:   make(chan []byte, subChanBuffer),
		quit: make(chan struct{}),
	}

	s.mu.Lock()
	id := s.subSeq
	s.subSeq++
	s.subs[id] = sub
	s.mu.Unlock()

	go s.dispatch(sub, fn)

	return func() {
		s.mu.Lock()
		delete(s.subs, id)
		s.mu.Unlock()
		sub.shutdown()
	}
}

// OnExit registers a callback invoked exactly once when the child exits;
// reason is "exit" for a clean exit, otherwise the error string (with the
// stderr tail appended when present). If the child has already exited, fn is
// invoked immediately with the recorded reason.
func (s *Session) OnExit(fn func(reason string)) {
	s.mu.Lock()
	if s.exited {
		reason := s.exitReason
		s.mu.Unlock()
		fn(reason)
		return
	}
	s.exitFns = append(s.exitFns, fn)
	s.mu.Unlock()
}

// StderrTail returns the last 4 KiB of the child's stderr output.
func (s *Session) StderrTail() string {
	s.mu.Lock()
	tail := string(s.stderrRing)
	s.mu.Unlock()
	return tail
}

// Close shuts the session down: closes stdin, sends SIGTERM to the child's
// process group, waits up to 3s for it to exit, then escalates to SIGKILL.
// It blocks until the child has been reaped and is idempotent.
func (s *Session) Close() error {
	s.closeOnce.Do(func() {
		s.closeStdin()
		s.signal(syscall.SIGTERM)

		select {
		case <-s.done:
			return
		case <-time.After(closeGrace):
		}
		s.signal(syscall.SIGKILL)
	})

	// Every caller (including repeat calls) blocks until the reaper is done —
	// no zombies, no goroutine leaks.
	<-s.done
	return nil
}

// closeStdin closes the child's stdin exactly once (EOF lets well-behaved
// children exit on their own).
func (s *Session) closeStdin() {
	s.mu.Lock()
	already := s.stdinDone
	s.stdinDone = true
	s.mu.Unlock()
	if !already {
		_ = s.stdin.Close()
	}
}

// signal delivers sig to the child's process group, falling back to the
// process itself if the group lookup fails. It is a no-op once the child has
// been reaped (guards against signaling a reused pid).
func (s *Session) signal(sig syscall.Signal) {
	select {
	case <-s.done:
		return // child already reaped; pid may have been reused
	default:
	}
	if s.cmd.Process == nil {
		return
	}
	pid := s.cmd.Process.Pid
	if pgid, err := syscall.Getpgid(pid); err == nil {
		_ = syscall.Kill(-pgid, sig)
	} else {
		_ = s.cmd.Process.Signal(sig)
	}
}
