package superbench

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// ReadRegisteredInput accepts only an owned finite pipe or regular request FD.
// Pipes get a short deadline, including the mandatory EOF after the one frame.
func ReadRegisteredInput(ctx context.Context, in *os.File, expectedSHA string) (RegisteredCapsule, error) {
	if in == nil || !ValidGroupedContextDigest(expectedSHA) {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	s, err := in.Stat()
	if err != nil {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	if s.Mode()&os.ModeNamedPipe != 0 {
		reader, err := registeredPipe(in)
		if err != nil {
			return RegisteredCapsule{}, err
		}
		defer reader.Close()
		in = reader
		until := time.Now().Add(5 * time.Second)
		if d, ok := ctx.Deadline(); ok && d.Before(until) {
			until = d
		}
		if in.SetReadDeadline(until) != nil {
			return RegisteredCapsule{}, ErrRegisteredFrame
		}
		defer in.SetReadDeadline(time.Time{})
	} else if !s.Mode().IsRegular() || s.Size() > MaxWorker+4 {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	if ctx.Err() != nil {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	var size [4]byte
	if _, err = io.ReadFull(in, size[:]); err != nil {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	n := binary.BigEndian.Uint32(size[:])
	if n == 0 || n > MaxWorker {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	raw := make([]byte, int(n))
	if _, err = io.ReadFull(in, raw); err != nil {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	var extra [1]byte
	if n, e := in.Read(extra[:]); n != 0 || e != io.EOF || groupedSHA(raw) != expectedSHA || ctx.Err() != nil {
		return RegisteredCapsule{}, ErrRegisteredFrame
	}
	return ParseRegisteredCapsule(raw)
}

// ExecuteRegisteredWorker has no mutation capability and creates no receipt or
// service-owned context. Producer admission owns the one execution opportunity.
// stdout is exclusively the framed result; harness stderr uses the other pipe.
func ExecuteRegisteredWorker(ctx context.Context, in *os.File, out, logs io.Writer, expectedSHA string) error {
	c, err := ReadRegisteredInput(ctx, in, expectedSHA)
	if err != nil {
		return err
	}
	if out == nil || logs == nil {
		return ErrRegisteredResult
	}
	cwd, err := os.Getwd()
	if err != nil || cwd != c.Task.WorkspaceRoot {
		return ErrRegisteredLayout
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(c.Task.TimeoutSeconds)*time.Second)
	defer cancel()
	preflight, done := context.WithTimeout(ctx, 30*time.Second)
	err = inspectRegistered(preflight, c)
	done()
	if err != nil {
		return err
	}
	part := ".root"
	selected := c.Task.WorkspaceRoot
	if c.Task.RepositoryName != "" {
		part = c.Task.RepositoryName
		selected = filepath.Join(selected, part)
	}
	runtime := filepath.Join(c.Task.WorkspaceRoot, ".superbench-runtime", part)
	cmd := exec.CommandContext(ctx, c.Task.Arguments[0], c.Task.Arguments[1:]...)
	cmd.Dir = selected
	cmd.Env = childEnvironment(WorkerSpec{Environment: c.Task.Environment}, runtime)
	cmd.WaitDelay = 2 * time.Second
	prompt, _ := json.Marshal(struct {
		Binding Binding `json:"binding"`
		Prompt  string  `json:"prompt"`
	}{c.Task.Binding, c.Task.Prompt})
	cmd.Stdin = bytes.NewReader(prompt)
	capture := &boundedBuffer{}
	cmd.Stdout = capture
	cmd.Stderr = logs
	if cmd.Run() != nil {
		return ErrRegisteredTask
	}
	raw, overflow := capture.read()
	var result WorkerResult
	if overflow || decodeGroupedResult(raw, &result, c.Task.Binding) != nil {
		return ErrRegisteredResult
	}
	// WorkerResult is task output only; fencing, checkpoint and release must
	// still be proven independently by the supervising producer after exit.
	return WriteRegisteredResult(out, result)
}
func WriteRegisteredResult(out io.Writer, result WorkerResult) error {
	if !result.Binding.valid() || result.Binding.Epoch > 1<<53-1 || !validGroupedResult(result, result.Binding) {
		return ErrRegisteredResult
	}
	raw, err := json.Marshal(result)
	if err != nil || len(raw) > MaxWorker {
		return ErrRegisteredResult
	}
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(raw)))
	frame := append(size[:], raw...)
	n, err := out.Write(frame)
	if err != nil || n != len(frame) {
		return ErrRegisteredResult
	}
	return nil
}

// ParseRegisteredResult refuses extra bytes, truncation, foreign binding and
// unknown/duplicate fields. Callers must separately verify producer lifecycle.
func ParseRegisteredResult(frame []byte, binding Binding) (WorkerResult, error) {
	var r WorkerResult
	if !binding.valid() || binding.Epoch > 1<<53-1 || len(frame) < 4 || len(frame) > MaxWorker+4 || int(binary.BigEndian.Uint32(frame[:4])) != len(frame)-4 || decodeGroupedResult(frame[4:], &r, binding) != nil {
		return r, ErrRegisteredResult
	}
	canonical, err := json.Marshal(r)
	if err != nil || !bytes.Equal(canonical, frame[4:]) {
		return WorkerResult{}, ErrRegisteredResult
	}
	return r, nil
}
