package descriptor

import (
	"bytes"
	"context"
	"io"
	"os"
	"time"
)

// tailDefaultN is the default number of lines returned by the initial log emit.
const tailDefaultN = 500

// tailWaitInterval is how often follow-mode TailLogs implementations poll
// for the first log file to appear when none exist yet. See
// waitForLogFiles.
const tailWaitInterval = 1 * time.Second

// waitForLogFiles blocks until collect() returns at least one file or ctx is
// cancelled, polling every tailWaitInterval. If collect() already has
// results on the first call, it returns immediately without waiting for a
// tick. Returns nil if ctx is cancelled before any file appears.
//
// Follow-mode TailLogs implementations call this before starting their
// append-polling loop so that a harness which hasn't written any log files
// yet doesn't cause the stream to close immediately — see the dogfooding bug
// (2026-08-09): follow-mode with zero matching log files returned right
// away, the hub then closed the SSE instantly, and the console's Logs tab
// retry-looped into "Disconnected" for any harness that hadn't written logs
// yet.
func waitForLogFiles(ctx context.Context, collect func() []string) []string {
	if files := collect(); len(files) > 0 {
		return files
	}

	ticker := time.NewTicker(tailWaitInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if files := collect(); len(files) > 0 {
				return files
			}
		}
	}
}

// tailMaxBytes is the maximum number of bytes read from the end of a log file
// for the initial emit. Files larger than this are seeked so only the tail
// portion is considered.
const tailMaxBytes int64 = 256 * 1024 // 256 KiB

// lastNLines returns the last n complete lines from the file at path, reading
// at most maxBytes from the end of the file.
//
// Algorithm:
//  1. Open the file and stat its size.
//  2. If size > maxBytes, seek to (size - maxBytes) before reading; otherwise
//     read from byte 0.
//  3. When a mid-file seek was performed, skip bytes up to and including the
//     first '\n' so the result never starts with a partial line.
//  4. Split the candidate block into lines (dropping the trailing empty element
//     caused by a file that ends with '\n'), then keep the last n lines.
//  5. Return the chosen lines joined by '\n' with a trailing '\n'.
//
// Returns (nil, nil) for an empty file or a read window that yields no whole
// lines. Returns an error only for OS-level failures.
func lastNLines(path string, n int, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, err
	}

	size := info.Size()
	if size == 0 {
		return nil, nil
	}

	// Determine the byte offset to seek to.
	var startOffset int64
	if size > maxBytes {
		startOffset = size - maxBytes
	}

	if startOffset > 0 {
		if _, err := f.Seek(startOffset, io.SeekStart); err != nil {
			return nil, err
		}
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}

	// If we seeked mid-file, discard bytes up to and including the first '\n'
	// so the very first returned line is always complete.
	if startOffset > 0 {
		idx := bytes.IndexByte(data, '\n')
		if idx < 0 {
			// The entire read window is one partial line — nothing usable.
			return nil, nil
		}
		data = data[idx+1:]
	}

	if len(data) == 0 {
		return nil, nil
	}

	// Split into lines. A file ending with '\n' produces a trailing empty
	// element — drop it so we count only real lines.
	lines := bytes.Split(data, []byte("\n"))
	if len(lines) > 0 && len(lines[len(lines)-1]) == 0 {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return nil, nil
	}

	// Keep only the last n lines.
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}

	result := bytes.Join(lines, []byte("\n"))
	result = append(result, '\n')
	return result, nil
}

// emitLastNLines reads the last n lines (up to maxBytes from the end) from
// each path and emits them via emit. Missing or empty files are silently
// skipped (best-effort). The first emit error is returned immediately.
func emitLastNLines(paths []string, n int, maxBytes int64, emit func([]byte) error) error {
	for _, path := range paths {
		data, err := lastNLines(path, n, maxBytes)
		if err != nil {
			continue // best effort — skip unreadable files
		}
		if len(data) == 0 {
			continue
		}
		if err := emit(data); err != nil {
			return err
		}
	}
	return nil
}
