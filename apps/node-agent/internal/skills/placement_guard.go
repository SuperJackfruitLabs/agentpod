package skills

import (
	"context"
	"fmt"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

// ApplyPlacementWhenIdle excludes cooperating ACP/terminal starts and refuses
// publication while any related activity is starting, running or being reaped.
// The caller must supply the same coordinator used by all process managers.
// This does not establish quiescence of external processes, lifecycle daemons
// or detached children, nor check harness version/mode. The lease lasts for this
// call; the transaction's durable recovery marker blocks later starts if the
// call is interrupted. It remains an internal building block, not an advertised
// remote activation capability.
func (s *InstallStore) ApplyPlacementWhenIdle(ctx context.Context, id, digest string, g *workspacegate.Coordinator) (PlacementReceipt, error) {
	if g == nil {
		return PlacementReceipt{}, fmt.Errorf("skills: workspace coordinator required")
	}
	repo, identity, err := s.placementRepository()
	if err != nil {
		return PlacementReceipt{}, err
	}
	lease, err := g.Exclusive(ctx, repo)
	if err != nil {
		return PlacementReceipt{}, err
	}
	defer lease.Release()
	again, identityAgain, err := s.placementRepository()
	if err != nil || again != repo || identityAgain != identity {
		return PlacementReceipt{}, fmt.Errorf("%w: repository changed during workspace admission", ErrInstallConflict)
	}
	return s.ApplyPlacement(ctx, id, digest)
}
