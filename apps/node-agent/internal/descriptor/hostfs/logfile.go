package hostfs

import (
	"io"
	"os"
)

// DefaultMaxBytes is the fallback cap when ReadFile is called with maxBytes == 0.
const DefaultMaxBytes = 1 << 20

// EmitLogFileFrom reads from offset and emits new bytes. Returns bytes read.
func EmitLogFileFrom(path string, offset int64, emit func([]byte) error) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return 0, err
	}
	if len(data) == 0 {
		return 0, nil
	}
	if err := emit(data); err != nil {
		return 0, err
	}
	return int64(len(data)), nil
}
