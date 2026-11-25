package benchattach

import (
	"context"
	"log"
	"time"
)

// Sweep detaches every attachment whose certificate expired more than SweepGrace ago. Nothing
// else would: a hub that lost track of an attempt never sends its detach, and the profile would
// stay pointed at a door that refuses it.
func (m Manager) Sweep(now time.Time) {
	mu.Lock()
	defer mu.Unlock()
	for _, id := range stations(m.Root) {
		r, ok, err := readRecord(m.Root, id)
		if err != nil {
			log.Printf("benchattach: sweep: %v", err)
			continue
		}
		if !ok || !now.After(r.ValidBefore.Add(SweepGrace)) {
			continue
		}
		if _, err := m.detach(r); err != nil {
			log.Printf("benchattach: sweep could not detach station %s: %v", id, err)
		}
	}
}

// RunSweep sweeps now and then every interval until ctx is done.
func (m Manager) RunSweep(ctx context.Context, interval time.Duration) {
	m.Sweep(m.now())
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.Sweep(m.now())
		}
	}
}
