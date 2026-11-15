// Package benchsourceio owns bounded private source request/reply file codecs.
// It supplies no source admission, journal locking or transport authority.
package benchsourceio

import (
	"bytes"
	"errors"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchjournal"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchsource"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"os"
	"path/filepath"
	"strconv"
)

const RequestHeader = "agentpod.private-source-request.v1\n"

func File(spec benchattempt.SourceSpec, step, suffix string) string {
	return benchattempt.RawSHA256([]byte(spec.BenchKey)) + "-" + benchattempt.SourceIdentitySHA256(spec) + "-" + step + suffix
}

func Request(root string, spec benchattempt.SourceSpec, step string) (benchworkspace.Request, []byte, error) {
	raw, err := benchjournal.ReadFile(filepath.Join(root, File(spec, step, ".request")), benchworkspace.MaxBody+len(RequestHeader), true)
	if err != nil {
		return benchworkspace.Request{}, nil, benchattempt.ErrPending
	}
	if !bytes.HasPrefix(raw, []byte(RequestHeader)) {
		return benchworkspace.Request{}, nil, benchattempt.ErrInvalid
	}
	raw = raw[len(RequestHeader):]
	r, err := benchworkspace.Parse(raw)
	if err != nil || !benchsource.RequestMatches(spec, step, r) {
		return benchworkspace.Request{}, nil, benchattempt.ErrInvalid
	}
	return r, raw, nil
}
func Reply(root string, spec benchattempt.SourceSpec, step string) (*benchworkspace.Response, error) {
	r, _, err := Request(root, spec, step)
	if err != nil {
		return nil, err
	}
	raw, err := benchjournal.ReadFile(filepath.Join(root, File(spec, step, ".response")), benchworkspace.MaxResponse+4, true)
	if err != nil {
		return nil, benchattempt.ErrPending
	}
	if len(raw) < 4 || raw[3] != '\n' {
		return nil, benchattempt.ErrInvalid
	}
	status, err := strconv.Atoi(string(raw[:3]))
	if err != nil {
		return nil, benchattempt.ErrInvalid
	}
	response, err := benchworkspace.ParseResponse(raw[4:], status, r)
	if err != nil {
		return nil, benchattempt.ErrInvalid
	}
	return &response, nil
}
func WriteExact(root, name string, raw []byte) error {
	old, err := benchjournal.ReadFile(filepath.Join(root, name), benchworkspace.MaxResponse+4, true)
	if err == nil {
		if !bytes.Equal(old, raw) {
			return benchattempt.ErrConflict
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return benchattempt.ErrInvalid
	}
	return benchjournal.WriteAtomic(root, name, raw)
}
