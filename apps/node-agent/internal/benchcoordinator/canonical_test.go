package benchcoordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcanonical"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

func runCapture(t *testing.T, c benchdispatch.SourceCoordinator, suffix string) (string, []byte) {
	t.Helper()
	names, e := os.ReadDir(c.Store.Root)
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range names {
		if strings.HasSuffix(name.Name(), "-run"+suffix) {
			path := filepath.Join(c.Store.Root, name.Name())
			raw, e := os.ReadFile(path)
			if e != nil {
				t.Fatal(e)
			}
			return path, raw
		}
	}
	t.Fatal("missing original run capture")
	return "", nil
}

func TestCanonicalProjectionUsesActualPlannedRunAndSavedSuccess(t *testing.T) {
	c, spec, _, _ := completionFixture(t)
	original, e := c.Binding(t.Context(), spec)
	if e != nil {
		t.Fatal(e)
	}
	b, d, e := c.Store.CanonicalSource(t.Context(), spec)
	if e != nil || d.SourceReceiptSHA256 != "" {
		t.Fatal("prepared canonical", d, e)
	}
	_, record := runCapture(t, c, ".request")
	raw := record[bytes.IndexByte(record, '\n')+1:]
	request, e := benchworkspace.Parse(raw)
	if e != nil || request.Operation != "run" || request.RequestID != spec.RunRequestID || request.LeaseToken == "" {
		t.Fatal("not the planned owned run", e)
	}
	want, e := benchcanonical.Digest(raw)
	if e != nil || want != d.SourceRequestSHA256 || want == b.RequestSHA256 || want == b.BodySHA256 {
		t.Fatal("raw/typed hashes relabeled", d, e)
	}
	before, _ := json.Marshal(original)
	after, _ := json.Marshal(b)
	if !bytes.Equal(before, after) {
		t.Fatal("source binding bytes changed")
	}
	_, _, _, pending, e := c.Store.CompletedCanonical(t.Context(), spec)
	if !errors.Is(e, benchdispatch.ErrPending) || pending != (benchcanonical.Digests{}) {
		t.Fatal("unexecuted receipt projected", pending, e)
	}
	if _, e = c.ExecuteBound(t.Context(), spec, func(context.Context, benchdispatch.SourceBinding) error { return nil }); e != nil {
		t.Fatal(e)
	}
	got, e := ReadCompletion(t.Context(), c.Store, spec)
	if e != nil {
		t.Fatal(e)
	}
	_, response := runCapture(t, c, ".response")
	receipt, e := benchcanonical.ReceiptDigest(response[4:])
	if e != nil || got.SourceRequestSHA256 != want || got.SourceReceiptSHA256 != receipt || got.SourceReceiptSHA256 == got.Service.ResponseSHA256 {
		t.Fatal("not full actual normalized receipt", e)
	}
	encoded, _ := json.Marshal(struct{ Request, Receipt string }{got.SourceRequestSHA256, got.SourceReceiptSHA256})
	if bytes.Contains(encoded, []byte(request.LeaseToken)) || bytes.Contains(encoded, []byte(spec.ContextParent)) {
		t.Fatal("canonical output disclosed private data")
	}
}

func TestCanonicalProjectionRejectsRewrittenCaptureEvenWhenCanonicalEqual(t *testing.T) {
	for _, response := range []bool{false, true} {
		c, spec, _, _ := completionFixture(t)
		if response {
			if _, e := c.ExecuteBound(t.Context(), spec, func(context.Context, benchdispatch.SourceBinding) error { return nil }); e != nil {
				t.Fatal(e)
			}
		}
		suffix := ".request"
		if response {
			suffix = ".response"
		}
		path, record := runCapture(t, c, suffix)
		prefix := bytes.IndexByte(record, '\n') + 1
		payload := record[prefix:]
		before, e := benchcanonical.Digest(payload)
		if e != nil {
			t.Fatal(e)
		}
		changed := append([]byte(" \n"), payload...)
		after, e := benchcanonical.Digest(changed)
		if e != nil || after != before {
			t.Fatal("not a canonical alias", e)
		}
		if e = os.WriteFile(path, append(append([]byte(nil), record[:prefix]...), changed...), 0600); e != nil {
			t.Fatal(e)
		}
		if response {
			_, _, _, d, e := c.Store.CompletedCanonical(t.Context(), spec)
			if e == nil || d != (benchcanonical.Digests{}) {
				t.Fatal("rewritten receipt accepted", d, e)
			}
		} else {
			_, d, e := c.Store.CanonicalSource(t.Context(), spec)
			if e == nil || d != (benchcanonical.Digests{}) {
				t.Fatal("rewritten request accepted", d, e)
			}
		}
	}
}

func TestCanonicalProjectionNeverRevivesCancelledAttempt(t *testing.T) {
	c, spec, _, _ := completionFixture(t)
	if e := c.Store.BeginCancellation(t.Context(), spec, c.Current); e != nil {
		t.Fatal(e)
	}
	_, d, e := c.Store.CanonicalSource(t.Context(), spec)
	if !errors.Is(e, benchdispatch.ErrOwner) || d != (benchcanonical.Digests{}) {
		t.Fatal("cancelled source projected", d, e)
	}
}
