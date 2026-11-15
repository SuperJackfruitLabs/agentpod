package benchworkspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestObservedUnixExchangeRetainsExactPrivateBytesOnce(t *testing.T) {
	request, body := leaseFixture(t)
	want, _ := json.Marshal(request)
	var calls atomic.Int32
	path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		got, _ := io.ReadAll(r.Body)
		if !bytes.Equal(got, want) {
			t.Error("sent bytes changed")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})
	client, err := NewClient(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	out, evidence, err := client.DoWithEvidence(context.Background(), request)
	if err != nil || out == nil || !out.OK || evidence == nil {
		t.Fatal("observed exchange failed", err)
	}
	if calls.Load() != 1 || evidence.RequestSHA256() != evidenceDigest(want) || evidence.ResponseSHA256() != evidenceDigest(body) {
		t.Fatal("wrong exact exchange hashes")
	}
	if err = evidence.Use(func(status int, sent, received []byte) error {
		if status != 200 || !bytes.Equal(sent, want) || !bytes.Equal(received, body) {
			t.Fatal("wrong evidence")
		}
		sent[0] = 'x'
		received[0] = 'x'
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if evidence.RequestSHA256() != evidenceDigest(want) || evidence.ResponseSHA256() != evidenceDigest(body) {
		t.Fatal("evidence mutable through sink")
	}
	raw, e := json.Marshal(evidence)
	if e == nil || len(raw) != 0 {
		t.Fatal("private evidence serializable")
	}
	for _, format := range []string{"%v", "%+v", "%#v"} {
		if got := fmt.Sprintf(format, evidence); got != "[private workspace exchange]" {
			t.Fatal("private formatting leak")
		}
	}
	if err = evidence.Use(func(int, []byte, []byte) error { return errors.New("private remote token") }); err == nil || strings.Contains(err.Error(), "token") || calls.Load() != 1 {
		t.Fatal("sink error leaked or retried", err)
	}
}

func TestObservedInvalidReplyRetainsBytesWithoutMakingItValid(t *testing.T) {
	request, _ := leaseFixture(t)
	body := []byte(`{"private_untrusted":"do-not-publish"}`)
	path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})
	client, err := NewClient(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	out, evidence, err := client.DoWithEvidence(context.Background(), request)
	var failure *Failure
	if out != nil || !errors.As(err, &failure) || !failure.Uncertain || evidence == nil || evidence.ResponseSHA256() != evidenceDigest(body) {
		t.Fatal("invalid reply became authoritative", err)
	}
}

func TestObservedLostReplyKeepsRequestOnlyAndNoRetry(t *testing.T) {
	request, _ := leaseFixture(t)
	var calls atomic.Int32
	path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		connection, _, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Error(e)
			return
		}
		_ = connection.Close()
	})
	client, err := NewClient(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	out, evidence, err := client.DoWithEvidence(context.Background(), request)
	var failure *Failure
	if out != nil || !errors.As(err, &failure) || !failure.Uncertain || evidence == nil || evidence.RequestSHA256() == "" || evidence.ResponseSHA256() != "" || calls.Load() != 1 {
		t.Fatal("lost exchange changed retry/evidence semantics", err)
	}
}
