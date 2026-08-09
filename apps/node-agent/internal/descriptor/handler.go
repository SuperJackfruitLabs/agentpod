package descriptor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// NewHandler returns a gateway.Handler that routes hub→node verbs to the
// Registry. Supported verbs:
//
//	detect    – aggregate station list (unary)
//	health    – station health snapshot (unary)
//	fs.list   – directory listing (unary)
//	fs.read   – file contents (unary, base64 or utf8 encoded)
//	logs.tail – streaming log tail (streamed)
//
// Terminal verbs (term.open/attach/close) and input/resize frame routing are
// handled by gateway.NewTerminalHandler, which wraps this handler.
func NewHandler(reg *Registry) gateway.Handler {
	return gateway.HandlerFunc(func(
		ctx context.Context,
		verb string,
		params json.RawMessage,
		emit func(seq int, chunk string, eof bool, enc string) error,
	) (any, bool, error) {
		switch verb {
		case "detect":
			return handleDetect(reg)

		case "health":
			return handleHealth(reg, params)

		case "fs.list":
			return handleFsList(reg, params)

		case "fs.read":
			return handleFsRead(reg, params)

		case "logs.tail":
			return handleLogsTail(ctx, reg, params, emit)

		case "cleanup.plan":
			return handleCleanupPlan(reg, params)

		case "cleanup.apply":
			return handleCleanupApply(reg, params)

		default:
			return nil, false, fmt.Errorf("descriptor: unknown verb %q", verb)
		}
	})
}

// Handler exposes typed per-station capability resolution over a Registry for
// the gateway wiring in cmd/agentpod-node. The verb-routing gateway.Handler is
// built separately by NewHandler; methods here are injected into the gateway
// as plain funcs, mirroring how lifecycleFn resolves the Lifecycle interface.
type Handler struct {
	reg *Registry
}

// NewCapabilityHandler returns a Handler resolving capabilities against reg.
func NewCapabilityHandler(reg *Registry) *Handler {
	return &Handler{reg: reg}
}

// ACPCommand resolves the descriptor for key and, when it implements
// ACPCommander, returns the ACP spawn command for the station. Descriptors
// that do not implement the interface yield an "acp not supported" error.
func (h *Handler) ACPCommand(key string) (argv []string, dir string, env []string, err error) {
	d, err := h.reg.For(key)
	if err != nil {
		return nil, "", nil, err
	}
	c, ok := d.(ACPCommander)
	if !ok {
		return nil, "", nil, fmt.Errorf("acp not supported for harness %q", d.Harness())
	}
	return c.ACPCommand(key)
}

// --- verb handlers ---

func handleDetect(reg *Registry) (any, bool, error) {
	stations := reg.DetectAll()
	if stations == nil {
		stations = []Station{}
	}
	return stations, false, nil
}

func handleHealth(reg *Registry, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("health: bad params: %w", err)
	}
	d, err := reg.For(p.Key)
	if err != nil {
		return nil, false, err
	}
	h, err := d.Health(p.Key)
	if err != nil {
		return nil, false, err
	}
	return h, false, nil
}

func handleFsList(reg *Registry, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key  string `json:"key"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("fs.list: bad params: %w", err)
	}
	d, err := reg.For(p.Key)
	if err != nil {
		return nil, false, err
	}
	entries, err := d.ListDir(p.Key, p.Path)
	if err != nil {
		return nil, false, err
	}
	if entries == nil {
		entries = []FsEntry{}
	}
	return entries, false, nil
}

func handleFsRead(reg *Registry, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key      string `json:"key"`
		Path     string `json:"path"`
		MaxBytes int64  `json:"maxBytes"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("fs.read: bad params: %w", err)
	}
	if p.MaxBytes <= 0 {
		p.MaxBytes = 1 << 20 // default 1 MiB
	}
	d, err := reg.For(p.Key)
	if err != nil {
		return nil, false, err
	}
	content, enc, truncated, err := d.ReadFile(p.Key, p.Path, p.MaxBytes)
	if err != nil {
		return nil, false, err
	}

	// Determine final encoding and string representation.
	// Descriptors may return an encoding hint; if absent we auto-detect.
	var contentStr string
	switch enc {
	case "utf8":
		contentStr = string(content)
	case "base64":
		contentStr = base64.StdEncoding.EncodeToString(content)
	default:
		// Auto-detect: prefer utf8 when valid, fall back to base64.
		if utf8.Valid(content) {
			enc = "utf8"
			contentStr = string(content)
		} else {
			enc = "base64"
			contentStr = base64.StdEncoding.EncodeToString(content)
		}
	}

	return map[string]any{
		"content":   contentStr,
		"encoding":  enc,
		"truncated": truncated,
	}, false, nil
}

func handleLogsTail(
	ctx context.Context,
	reg *Registry,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	var p struct {
		Key    string `json:"key"`
		Follow bool   `json:"follow"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, true, fmt.Errorf("logs.tail: bad params: %w", err)
	}
	d, err := reg.For(p.Key)
	if err != nil {
		return nil, true, err
	}

	seq := 0
	emitChunk := func(chunk []byte) error {
		s := seq
		seq++
		return emit(s, string(chunk), false, "") // enc="" → utf8 (field omitted)
	}

	if err := d.TailLogs(ctx, p.Key, p.Follow, emitChunk); err != nil && ctx.Err() == nil {
		return nil, true, err
	}
	return nil, true, nil
}

func handleCleanupPlan(reg *Registry, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("cleanup.plan: bad params: %w", err)
	}
	d, err := reg.For(p.Key)
	if err != nil {
		return nil, false, err
	}
	c, ok := d.(Cleaner)
	if !ok {
		return nil, false, fmt.Errorf("cleanup.plan: station %q does not support cleanup", p.Key)
	}
	items, err := c.CleanPlan(p.Key)
	if err != nil {
		return nil, false, err
	}
	if items == nil {
		items = []CleanItem{}
	}
	var total int64
	for _, item := range items {
		total += item.Size
	}
	return map[string]any{
		"items":      items,
		"totalBytes": total,
	}, false, nil
}

func handleCleanupApply(reg *Registry, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key   string   `json:"key"`
		Paths []string `json:"paths"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("cleanup.apply: bad params: %w", err)
	}
	d, err := reg.For(p.Key)
	if err != nil {
		return nil, false, err
	}
	c, ok := d.(Cleaner)
	if !ok {
		return nil, false, fmt.Errorf("cleanup.apply: station %q does not support cleanup", p.Key)
	}
	removed, err := c.CleanApply(p.Key, p.Paths)
	if err != nil {
		return nil, false, err
	}
	return map[string]any{
		"removedBytes": removed,
	}, false, nil
}
