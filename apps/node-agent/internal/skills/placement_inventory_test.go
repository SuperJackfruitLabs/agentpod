package skills

import (
	"context"
	"strings"
	"testing"
)

// A harness that can report its own inventory is a better collision authority
// than a filesystem walk, and for some harnesses it is the ONLY workable one.
// An OpenClaw home idiomatically holds symlinked skills -- clawhub links
// `~/.openclaw/skills/<name>` at `~/.agents/skills/<name>` -- and the scan
// refuses a symlink as an ambiguous entry rather than following it out of the
// root, which blocked every placement on a real home. Asking OpenClaw resolves
// the name exactly, with no traversal at all.
func TestHarnessInventoryDecidesCollisionsWhenAvailable(t *testing.T) {
	ctx := context.Background()

	t.Run("a name the harness already reports is a conflict", func(t *testing.T) {
		s := &InstallStore{binding: InstallBinding{Harness: "openclaw"}}
		s.UseHarnessInventory(func(context.Context) (map[string]string, error) {
			return map[string]string{"ai-elements": "ready", "taken": "ready"}, nil
		})
		err := s.placementCollisionsByReport(ctx, map[string]bool{"taken": true}, nil)
		if err == nil || !strings.Contains(err.Error(), "taken") {
			t.Fatalf("a reported name must conflict, got %v", err)
		}
	})

	t.Run("an unrelated inventory permits the placement", func(t *testing.T) {
		s := &InstallStore{binding: InstallBinding{Harness: "openclaw"}}
		s.UseHarnessInventory(func(context.Context) (map[string]string, error) {
			return map[string]string{"ai-elements": "ready"}, nil
		})
		if err := s.placementCollisionsByReport(ctx, map[string]bool{"sjl-fixture": true}, nil); err != nil {
			t.Fatalf("a symlinked neighbour must not block an unrelated name: %v", err)
		}
	})

	t.Run("a name this placement already owns is not a collision", func(t *testing.T) {
		s := &InstallStore{binding: InstallBinding{Harness: "openclaw"}}
		s.UseHarnessInventory(func(context.Context) (map[string]string, error) {
			return map[string]string{"sjl-fixture": "ready"}, nil
		})
		// Re-placing what we already published must not refuse itself.
		if err := s.placementCollisionsByReport(ctx, map[string]bool{"sjl-fixture": true}, map[string]bool{"sjl-fixture": true}); err != nil {
			t.Fatalf("re-placing an owned name conflicted with itself: %v", err)
		}
	})

	t.Run("an unreadable report refuses rather than permitting", func(t *testing.T) {
		s := &InstallStore{binding: InstallBinding{Harness: "openclaw"}}
		s.UseHarnessInventory(func(context.Context) (map[string]string, error) {
			return nil, context.DeadlineExceeded
		})
		// The one thing this must never do is read a failed report as "no
		// collisions" -- that would publish over a name the harness holds.
		if err := s.placementCollisionsByReport(ctx, map[string]bool{"sjl-fixture": true}, nil); err == nil {
			t.Fatal("a failed harness report was treated as an empty inventory")
		}
	})

	t.Run("a harness with no reporter leaves the walk in charge", func(t *testing.T) {
		s := &InstallStore{binding: InstallBinding{Harness: "codex"}}
		s.UseHarnessInventory(func(context.Context) (map[string]string, error) {
			return nil, nil // "this harness cannot report"
		})
		listed, err := s.reportedSkills(ctx)
		if err != nil || listed != nil {
			t.Fatalf("a non-reporting harness must yield no inventory and no error, got %v %v", listed, err)
		}
	})
}
