package skills

import "context"

// placementCollisionsByReport exercises the report path alone, without a
// workspace on disk, so the decision can be tested apart from the walk.
func (s *InstallStore) placementCollisionsByReport(ctx context.Context, names, owned map[string]bool) error {
	listed, err := s.reportedSkills(ctx)
	if err != nil {
		return err
	}
	return harnessInventoryCollision(listed, names, owned)
}
