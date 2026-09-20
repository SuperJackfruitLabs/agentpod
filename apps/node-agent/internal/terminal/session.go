// Package terminal provides a PTY-backed terminal session manager with
// ring-buffer scrollback and multi-subscriber pub/sub.
package terminal

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

// ringBytes is the maximum number of bytes kept in the scrollback ring buffer.
const ringBytes = 256 * 1024

// subscriber holds a channel that receives PTY output chunks.
type subscriber struct {
	ch chan []byte
}

// Session wraps a single PTY process. It is safe for concurrent use.
type Session struct {
	// ID is the unique session identifier (e.g. "sess-1").
	ID string

	ptm *os.File
	cmd *exec.Cmd

	mu     sync.Mutex
	ring   []byte // scrollback ring buffer (last ringBytes)
	subs   map[int]*subscriber
	subSeq int  // monotonic key for subs map
	exited bool // read loop finished; late subscriptions close immediately

	closeOnce sync.Once
	readDone  chan struct{}
	done      chan struct{} // closed after read loop exit AND child reaping
}

// newSession spawns a PTY-attached process and returns a running Session.
// When using a PTY, the child becomes a session leader automatically
// (the PTY slave is its controlling terminal), so we do NOT set Setpgid —
// it conflicts with the PTY allocation on macOS.
func newSession(id, shell, cwd string, cols, rows uint16) (*Session, error) {
	if shell == "" {
		shell = "/bin/sh"
	}

	cmd := exec.Command(shell)
	cmd.Dir = cwd

	size := &pty.Winsize{Cols: cols, Rows: rows}
	ptm, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return nil, err
	}

	s := &Session{
		ID:       id,
		ptm:      ptm,
		cmd:      cmd,
		subs:     make(map[int]*subscriber),
		done:     make(chan struct{}),
		readDone: make(chan struct{}),
	}
	go s.readLoop()
	go func() {
		<-s.readDone
		_ = s.cmd.Wait()
		_ = s.ptm.Close()
		close(s.done)
	}()
	return s, nil
}

// readLoop copies PTY output into the ring buffer and every subscriber channel.
// It exits when the PTY file returns an error (closed or EOF), which is
// triggered by Close() calling ptm.Close().
func (s *Session) readLoop() {
	defer close(s.readDone)

	buf := make([]byte, 4096)
	for {
		n, err := s.ptm.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			s.mu.Lock()
			// Append to ring; keep only the last ringBytes.
			s.ring = appendRing(s.ring, chunk)
			// Fan out to subscribers — non-blocking; drop on slow consumer.
			for _, sub := range s.subs {
				select {
				case sub.ch <- chunk:
				default:
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}

	// Notify remaining subscribers that the session has ended.
	s.mu.Lock()
	s.exited = true
	for id, sub := range s.subs {
		close(sub.ch)
		delete(s.subs, id)
	}
	s.mu.Unlock()
}

// appendRing appends data to buf and trims to the last ringBytes bytes.
func appendRing(buf, data []byte) []byte {
	buf = append(buf, data...)
	if len(buf) > ringBytes {
		buf = buf[len(buf)-ringBytes:]
	}
	return buf
}

// Write sends p to the PTY's stdin.
func (s *Session) Write(p []byte) error {
	_, err := s.ptm.Write(p)
	return err
}

// Resize sets the PTY window size.
func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.ptm, &pty.Winsize{Cols: cols, Rows: rows})
}

// Subscribe returns a channel that receives PTY output and an unsubscribe
// function. On subscribe, the current ring-buffer contents are delivered as
// the first message (scrollback replay); subsequent messages are live output.
// The channel is buffered; on a slow consumer, live chunks are DROPPED rather
// than blocking the PTY read loop. Calling the returned func detaches this
// subscriber without closing the session.
func (s *Session) Subscribe() (<-chan []byte, func()) {
	// Buffer must be large enough to accept the replay chunk without blocking
	// while we still hold the lock.
	ch := make(chan []byte, 128)

	s.mu.Lock()
	// Deliver a snapshot of the scrollback ring as the first message.
	if len(s.ring) > 0 {
		snap := make([]byte, len(s.ring))
		copy(snap, s.ring)
		ch <- snap // always succeeds: fresh channel, guaranteed capacity >= 1
	}
	if s.exited {
		close(ch)
		s.mu.Unlock()
		return ch, func() {}
	}
	// Register the subscriber so the read loop starts delivering live chunks.
	id := s.subSeq
	s.subSeq++
	s.subs[id] = &subscriber{ch: ch}
	s.mu.Unlock()

	unsub := func() {
		s.mu.Lock()
		delete(s.subs, id)
		s.mu.Unlock()
	}
	return ch, unsub
}

// Close kills the child process (by its process group) and closes the PTY
// file. Every caller waits until the read loop exits and the child is reaped.
func (s *Session) Close() error {
	s.closeOnce.Do(func() {
		select {
		case <-s.done:
			return
		default:
		}
		// PTY children lead their own process group. This signals that group;
		// only the direct child is reaped here, not arbitrary detached children.
		if s.cmd.Process != nil {
			pgid, err := syscall.Getpgid(s.cmd.Process.Pid)
			if err == nil {
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			} else {
				_ = s.cmd.Process.Kill()
			}
		}
		_ = s.ptm.Close()
	})
	<-s.done
	return nil
}
