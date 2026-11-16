package superbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func registeredCodecFixture(t *testing.T) RegisteredCapsule {
	t.Helper()
	task := groupedSpecForTest(t)
	n := uint64(0)
	node := func() RegisteredNode { n++; return RegisteredNode{Device: "1", Inode: strconv.FormatUint(n, 10)} }
	return RegisteredCapsule{Version: RegisteredWorkerVersion, Task: task, Layout: RegisteredLayout{Key: task.BenchKey, BenchID: task.BenchID, Version: RegisteredLayoutVersion, PolicySHA256: strings.Repeat("a", 64), Root: node(), RootHome: node(), RootTemp: node(), Members: []RegisteredMember{{Name: "a", Checkout: node(), Admin: node(), Home: node(), Temp: node()}}}}
}
func frameCapsule(raw []byte) []byte {
	var b [4]byte
	n := len(raw)
	b = [4]byte{byte(n >> 24 & 255), byte(n >> 16 & 255), byte(n >> 8 & 255), byte(n & 255)}
	return append(b[:], raw...)
}
func TestRegisteredCapsuleStrictNoncredentialRoundtrip(t *testing.T) {
	c := registeredCodecFixture(t)
	raw, err := c.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseRegisteredCapsule(raw)
	if err != nil || got.Task.BenchID != c.Task.BenchID {
		t.Fatal(err)
	}
	for _, field := range []string{"lease_token", "grant", "source_receipt", "reporter_token", "context_path"} {
		bad := append([]byte(nil), raw[:len(raw)-1]...)
		bad = append(bad, []byte(`,"`+field+`":"secret"}`)...)
		if _, err := ParseRegisteredCapsule(bad); !errors.Is(err, ErrRegisteredFrame) {
			t.Fatalf("%s wrong refusal: %v", field, err)
		}
	}
	for _, change := range []func(*RegisteredCapsule){
		func(c *RegisteredCapsule) { c.Task.Environment["BENCH_LEASE_TOKEN"] = "secret" },
		func(c *RegisteredCapsule) { c.Layout.BenchID = strings.Repeat("b", 32) },
		func(c *RegisteredCapsule) { c.Layout.Root.Inode = "01" },
		func(c *RegisteredCapsule) { c.Layout.Root.Inode = "18446744073709551616" },
		func(c *RegisteredCapsule) { c.Layout.Members[0].Checkout = c.Layout.Root },
		func(c *RegisteredCapsule) { c.Layout.Members[0].Name = "foreign" },
	} {
		next := registeredCodecFixture(t)
		change(&next)
		if _, err := next.Bytes(); err == nil {
			t.Fatal("invalid capsule admitted")
		}
	}
	for _, bad := range [][]byte{append(append([]byte(nil), raw...), '\n'), bytes.Replace(raw, []byte(`"version":`), []byte(`"version":"duplicate","version":`), 1), []byte(`null`)} {
		if _, err := ParseRegisteredCapsule(bad); !errors.Is(err, ErrRegisteredFrame) {
			t.Fatal("noncanonical capsule accepted", err)
		}
	}
}
func TestRegisteredFrameExactDigestEOFAndBoundedPipe(t *testing.T) {
	c := registeredCodecFixture(t)
	raw, err := c.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{frameCapsule(raw)[:2], append(frameCapsule(raw), 0), {0, 1, 0, 1}} {
		f, err := os.CreateTemp(t.TempDir(), "input")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.Write(bad); err != nil {
			t.Fatal(err)
		}
		_, _ = f.Seek(0, 0)
		if _, err = ReadRegisteredInput(context.Background(), f, groupedSHA(raw)); !errors.Is(err, ErrRegisteredFrame) {
			t.Fatal("bad frame accepted", err)
		}
		_ = f.Close()
	}
	f, err := os.CreateTemp(t.TempDir(), "input")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_, _ = f.Write(frameCapsule(raw))
	_, _ = f.Seek(0, 0)
	if _, err = ReadRegisteredInput(context.Background(), f, groupedSHA(raw)); err != nil {
		t.Fatal(err)
	}
	_, _ = f.Seek(0, 0)
	if _, err = ReadRegisteredInput(context.Background(), f, strings.Repeat("0", 64)); !errors.Is(err, ErrRegisteredFrame) {
		t.Fatal("digest substitution", err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err = ReadRegisteredInput(ctx, r, groupedSHA(raw)); !errors.Is(err, ErrRegisteredFrame) {
		t.Fatal("partial input", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("partial header outlived request deadline")
	}
}
func TestRegisteredResultFramingBindsOutcomeNotAuthority(t *testing.T) {
	c := registeredCodecFixture(t)
	r := WorkerResult{Version: GroupedWorkerVersion, Binding: c.Task.Binding, Outcome: "complete", Handoff: map[string]string{"summary": "done"}}
	var out bytes.Buffer
	if err := WriteRegisteredResult(&out, r); err != nil {
		t.Fatal(err)
	}
	got, err := ParseRegisteredResult(out.Bytes(), r.Binding)
	if err != nil || got.Outcome != "complete" {
		t.Fatal(err)
	}
	wrong := r.Binding
	wrong.Epoch++
	if _, err = ParseRegisteredResult(out.Bytes(), wrong); !errors.Is(err, ErrRegisteredResult) {
		t.Fatal("foreign epoch", err)
	}
	raw, _ := json.Marshal(r)
	for _, bad := range [][]byte{append(out.Bytes(), 0), frameCapsule(append(raw, '\n')), out.Bytes()[:3]} {
		if _, err = ParseRegisteredResult(bad, r.Binding); !errors.Is(err, ErrRegisteredResult) {
			t.Fatal("malformed result", err)
		}
	}
}
