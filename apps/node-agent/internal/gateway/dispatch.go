package gateway

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
)

// reqIDKey is an unexported context key used to pass the current request ID
// into Handler.Handle so long-lived handlers (e.g. term.attach) can key
// their per-request state.
type reqIDKey struct{}

// Handler handles a hub→node verb request.
//
// emit writes a stream frame; seq is the frame sequence number, chunk is the
// payload, eof signals the last frame in the stream, enc is the encoding
// ("base64" or "" to omit the field, implying utf8). If streamed is true the
// dispatcher appends one final {type:"stream",eof:true} frame after Handle
// returns. If streamed is false the dispatcher writes a {type:"res"} frame.
type Handler interface {
	Handle(ctx context.Context, verb string, params json.RawMessage, emit func(seq int, chunk string, eof bool, enc string) error) (result any, streamed bool, err error)
}

// HandlerFunc is a function adapter for Handler.
type HandlerFunc func(ctx context.Context, verb string, params json.RawMessage, emit func(seq int, chunk string, eof bool, enc string) error) (any, bool, error)

func (f HandlerFunc) Handle(ctx context.Context, verb string, params json.RawMessage, emit func(seq int, chunk string, eof bool, enc string) error) (any, bool, error) {
	return f(ctx, verb, params, emit)
}

// FrameHandler may be implemented by a Handler to receive inbound hub→node
// frames that are not req/cancel (currently: "input" and "resize" for
// terminal stdin and window-size changes).
type FrameHandler interface {
	HandleFrame(frameType, id string, raw json.RawMessage) error
}

// inboundEnvelope is the decoded shape of a hub→node message.
type inboundEnvelope struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	Verb   string          `json:"verb"`
	Params json.RawMessage `json:"params"`
}

// serve is the read-loop for inbound hub→node messages. It dispatches req
// frames to h in per-request goroutines and handles cancel frames.
//
// If a writeMu is supplied (variadic first element) all WS writes — both from
// serve and from any concurrent heartbeat loop in the caller — share that
// mutex. Otherwise serve allocates its own mutex (sufficient when no external
// writer exists, as in tests).
func serve(ctx context.Context, c *websocket.Conn, h Handler, mus ...*sync.Mutex) {
	var writeMu *sync.Mutex
	if len(mus) > 0 && mus[0] != nil {
		writeMu = mus[0]
	} else {
		writeMu = &sync.Mutex{}
	}

	// writeMsg serializes all outbound frames over the shared mutex.
	writeMsg := func(writeCtx context.Context, v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		return c.Write(writeCtx, websocket.MessageText, b)
	}

	// cancels tracks the CancelFunc for each in-flight request.
	var (
		cancelsMu sync.Mutex
		cancels   = make(map[string]context.CancelFunc)
	)

	for {
		if ctx.Err() != nil {
			return
		}
		_, raw, err := c.Read(ctx)
		if err != nil {
			// Surface WHY the connection died (close code, EOF, reset) — the
			// caller only ever sees a later "use of closed network connection"
			// write failure, which hides the real cause.
			if ctx.Err() == nil {
				log.Printf("gateway: read loop closed: %v", err)
			}
			return
		}

		var env inboundEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}

		switch env.Type {
		case "req":
			reqID := env.ID
			verb := env.Verb
			params := env.Params

			reqCtx, cancel := context.WithCancel(ctx)
			cancelsMu.Lock()
			cancels[reqID] = cancel
			cancelsMu.Unlock()

			go func() {
				defer func() {
					cancel()
					cancelsMu.Lock()
					delete(cancels, reqID)
					cancelsMu.Unlock()
				}()

				// seqNext tracks the next expected sequence number so the
				// dispatcher can append the correct seq on the final eof frame.
				var seqNext int64

				emit := func(seq int, chunk string, eof bool, enc string) error {
					// Stop streaming once the request is cancelled — and never
					// pass reqCtx to the write itself: coder/websocket CLOSES
					// THE WHOLE CONNECTION when a Write's ctx is cancelled
					// mid-write (conn.go setupWriteTimeout → c.close()), so a
					// single stream cancel (console navigating away from a
					// logs tail) would tear down the entire gateway. Writes
					// ride the connection-lifetime ctx instead; a few frames
					// may land after cancel and are dropped by the hub.
					if reqCtx.Err() != nil {
						return reqCtx.Err()
					}
					atomic.StoreInt64(&seqNext, int64(seq)+1)
					m := map[string]any{
						"type":  "stream",
						"id":    reqID,
						"seq":   seq,
						"chunk": chunk,
						"eof":   eof,
					}
					if enc != "" {
						m["enc"] = enc
					}
					return writeMsg(ctx, m)
				}

				// Embed the request ID in context so handlers such as
				// term.attach can key per-attach state by request ID.
				reqCtxWithID := context.WithValue(reqCtx, reqIDKey{}, reqID)
				result, streamed, herr := h.Handle(reqCtxWithID, verb, params, emit)

				if streamed {
					// Send the terminal eof frame; use the parent ctx so we
					// can still send even if the handler's reqCtx was cancelled.
					// chunk must be present (as null) so the hub's StreamMsg
					// schema (chunk: z.string().nullable()) validates successfully.
					finalSeq := int(atomic.LoadInt64(&seqNext))
					_ = writeMsg(ctx, map[string]any{
						"type":  "stream",
						"id":    reqID,
						"seq":   finalSeq,
						"chunk": nil,
						"eof":   true,
					})
				} else {
					if herr != nil {
						_ = writeMsg(ctx, map[string]any{
							"type":  "res",
							"id":    reqID,
							"ok":    false,
							"error": herr.Error(),
						})
					} else {
						_ = writeMsg(ctx, map[string]any{
							"type": "res",
							"id":   reqID,
							"ok":   true,
							"data": result,
						})
					}
				}
			}()

		case "cancel":
			cancelsMu.Lock()
			if cancel, ok := cancels[env.ID]; ok {
				cancel()
			}
			cancelsMu.Unlock()

		case "input", "resize":
			// Route terminal input/resize frames to the handler if it supports them.
			if fh, ok := h.(FrameHandler); ok {
				// Pass the full raw frame so HandleFrame can unpack data/cols/rows.
				rawCopy := make([]byte, len(raw))
				copy(rawCopy, raw)
				_ = fh.HandleFrame(env.Type, env.ID, rawCopy)
			}
		}
	}
}
