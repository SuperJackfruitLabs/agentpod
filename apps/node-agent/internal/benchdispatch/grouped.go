package benchdispatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"reflect"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func validateGroupedLaunch(p Plan, raw []byte) error {
	r, err := benchworkspace.Parse(raw)
	if err != nil {
		return ErrInvalid
	}
	body, err := r.Digest()
	if err != nil || body != p.BodySHA256 || r.Operation != "run" || r.Key != p.BenchKey || r.Holder != p.Holder || r.RequestID != p.RequestID || r.LeaseToken == "" || r.RepositoryName != "" || len(r.Arguments) != 3 || r.Arguments[0] != p.ExecutablePath || r.Arguments[1] != p.ContextPath || r.Arguments[2] != p.ContextSHA256 || r.Checkpoint != nil && !*r.Checkpoint {
		return ErrInvalid
	}
	if physicalDir(p.ContextPath, true) != nil {
		return ErrInvalid
	}
	contextRaw, err := readFile(filepath.Join(p.ContextPath, "request.json"), superbench.MaxWorker, true)
	if err != nil || digest(contextRaw) != p.ContextSHA256 || !utf8.Valid(contextRaw) {
		return ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(contextRaw))
	if unique(d, 0, false) != nil {
		return ErrInvalid
	}
	if _, err = d.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	var spec superbench.GroupedWorkerSpec
	d = json.NewDecoder(bytes.NewReader(contextRaw))
	d.DisallowUnknownFields()
	if d.Decode(&spec) != nil || spec.Version != superbench.GroupedWorkerVersion || spec.Binding.BoardID != p.Identity.BoardID || spec.Binding.CardID != p.Identity.CardID || spec.Binding.RunID != p.Identity.RunID || spec.Binding.Epoch != p.Identity.Epoch || spec.BenchKey != p.BenchKey || spec.BenchID != p.RegistrationID || spec.WorkspaceRoot != p.Grouped.WorkspaceRoot || spec.RepositoryName != p.Grouped.RepositoryName || !reflect.DeepEqual(spec.Members, p.Grouped.Members) {
		return ErrInvalid
	}
	// This binds the exact launch and context; actual checkout/preparation checks
	// remain the protected worker's job inside benchd.run, never a ledger claim.
	real, err := filepath.EvalSymlinks(p.ExecutablePath)
	if err != nil || real != p.ExecutablePath {
		return ErrInvalid
	}
	binary, err := readFile(p.ExecutablePath, 64<<20, false)
	if err != nil || digest(binary) != p.ExecutableSHA256 {
		return ErrInvalid
	}
	return nil
}
