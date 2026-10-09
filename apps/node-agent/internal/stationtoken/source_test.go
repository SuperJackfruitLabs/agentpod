package stationtoken

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock is a settable clock, so a session longer than a token's life is simulated rather
// than waited out.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func TestSourceCachesATokenUntilItNearsExpiry(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_800_000_000, 0)}
	var mints atomic.Int32
	s := &Source{Now: clock.Now, mint: func(_ context.Context, station string) (string, error) {
		mints.Add(1)
		return jwt(clock.Now().Add(5 * time.Minute)), nil
	}}

	first, err := s.Token(context.Background(), "station_1")
	if err != nil {
		t.Fatal(err)
	}
	// Two minutes later the token still has three left: reused.
	clock.Advance(2 * time.Minute)
	again, _ := s.Token(context.Background(), "station_1")
	if again != first || mints.Load() != 1 {
		t.Fatalf("a token with 3 minutes left was replaced (mints=%d)", mints.Load())
	}
	// Past the refresh floor: replaced before it can expire mid-request.
	clock.Advance(90 * time.Second)
	if _, err := s.Token(context.Background(), "station_1"); err != nil {
		t.Fatal(err)
	}
	if mints.Load() != 2 {
		t.Fatalf("a token with 90 s left was not refreshed (mints=%d)", mints.Load())
	}
}

// A session that runs well past one token's five-minute life never hands out an expired token.
func TestSourceNeverHandsOutAnExpiredTokenAcrossALongSession(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_800_000_000, 0)}
	s := &Source{Now: clock.Now, mint: func(_ context.Context, _ string) (string, error) {
		return jwt(clock.Now().Add(5 * time.Minute)), nil
	}}
	for elapsed := time.Duration(0); elapsed <= 30*time.Minute; elapsed += 20 * time.Second {
		tok, err := s.Token(context.Background(), "station_1")
		if err != nil {
			t.Fatal(err)
		}
		exp, ok := expiryOf(tok)
		if !ok {
			t.Fatal("unreadable token")
		}
		if left := exp.Sub(clock.Now()); left < refreshFloor {
			t.Fatalf("at +%s the token handed out had only %s left", elapsed, left)
		}
		clock.Advance(20 * time.Second)
	}
}

func TestSourceIsSingleFlightPerStation(t *testing.T) {
	var mints atomic.Int32
	release := make(chan struct{})
	s := &Source{mint: func(_ context.Context, station string) (string, error) {
		mints.Add(1)
		<-release
		return jwt(time.Now().Add(5 * time.Minute)), nil
	}}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Token(context.Background(), "station_1"); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if mints.Load() != 1 {
		t.Fatalf("20 concurrent callers caused %d mints, want 1", mints.Load())
	}
}

func TestSourceKeepsStationsApart(t *testing.T) {
	s := &Source{mint: func(_ context.Context, station string) (string, error) {
		return jwt(time.Now().Add(5*time.Minute)) + station, nil // the signature segment names it
	}}
	a, _ := s.Token(context.Background(), "station_a")
	b, _ := s.Token(context.Background(), "station_b")
	if !strings.HasSuffix(a, "station_a") || !strings.HasSuffix(b, "station_b") {
		t.Fatalf("tokens crossed stations: %q / %q", a, b)
	}
}

func TestSourceDoesNotCacheAFailure(t *testing.T) {
	var calls atomic.Int32
	s := &Source{mint: func(_ context.Context, _ string) (string, error) {
		if calls.Add(1) == 1 {
			return "", errors.New("hub answered 503")
		}
		return jwt(time.Now().Add(5 * time.Minute)), nil
	}}
	if _, err := s.Token(context.Background(), "station_1"); err == nil {
		t.Fatal("want the first failure")
	}
	if _, err := s.Token(context.Background(), "station_1"); err != nil {
		t.Fatalf("a failure was cached: %v", err)
	}
}

func TestSourceMintsThroughTheHubWithTheNodeCredential(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		w.Write([]byte(`{"token":"` + jwt(time.Now().Add(5*time.Minute)) + `","expiresIn":300}`))
	}))
	defer srv.Close()
	s := &Source{Hub: srv.URL, NodeID: "node_1", NodeSecret: "sek", Client: srv.Client()}
	tok, err := s.Token(context.Background(), "station_9")
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer node_1:sek" || gotPath != "/api/nodes/node_1/stations/station_9/token" {
		t.Fatalf("auth=%q path=%q", gotAuth, gotPath)
	}
	if strings.Contains(tok, "sek") {
		t.Fatal("the node secret leaked into the station token")
	}
}

func TestSourceRefusesATokenWithNoReadableExpiry(t *testing.T) {
	// A token whose life cannot be read cannot be cached safely; it is an error, not forever.
	s := &Source{mint: func(_ context.Context, _ string) (string, error) { return "not-a-jwt", nil }}
	if _, err := s.Token(context.Background(), "station_1"); err == nil {
		t.Fatal("want an error for a token with no readable exp")
	}
}
