package skills

import (
	"errors"
	"fmt"
	"os"
	"path"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

type placementAdmission struct {
	SchemaVersion      int            `json:"schemaVersion"`
	Binding            InstallBinding `json:"binding"`
	OperationID        string         `json:"operationId"`
	PlanDigest         string         `json:"planDigest"`
	RepositoryIdentity string         `json:"repositoryIdentity"`
}

func admissionFor(p PlacementPlan) placementAdmission {
	return placementAdmission{1, p.Binding, p.OperationID, p.PlanDigest, p.RepositoryIdentity}
}

func readPlacementAdmission(repo string) (*placementAdmission, error) {
	root, err := os.OpenRoot(repo)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	var fence placementAdmission
	state := InstallStore{root: root}
	err = state.readJSON(workspacegate.RecoveryMarker, &fence)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w: unreadable native admission fence: %v", ErrInstallConflict, err)
	}
	return &fence, nil
}

// All writer calls hold the repository placement lock. A complete fence is
// published with a rename and directory fsync before the first native journal
// or discovery change. Incomplete fence writes remain outside the marker path.
func (s *InstallStore) beginPlacementAdmission(p PlacementPlan) error {
	existing, err := readPlacementAdmission(p.RepositoryPath)
	if err != nil {
		return err
	}
	want := admissionFor(p)
	if existing != nil {
		if *existing != want {
			return fmt.Errorf("%w: another native operation owns admission", ErrInstallConflict)
		}
		return nil
	}
	root, err := os.OpenRoot(p.RepositoryPath)
	if err != nil {
		return err
	}
	defer root.Close()
	directory := path.Dir(workspacegate.RecoveryMarker)
	if err := makeDirs(root, directory+"/pending"); err != nil {
		return err
	}
	// Persist each newly introduced directory before publishing the fence.
	for _, dir := range []string{directory + "/pending", directory, ".agentpod-skills", "."} {
		if err := syncDir(root, dir); err != nil {
			return err
		}
	}
	admissionRoot, err := root.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer admissionRoot.Close()
	state := InstallStore{root: admissionRoot}
	if err := state.writeJSON(path.Base(workspacegate.RecoveryMarker), want); err != nil {
		return err
	}
	return s.checkpoint("native-admission")
}

func (s *InstallStore) finishPlacementAdmission(p PlacementPlan) error {
	existing, err := readPlacementAdmission(p.RepositoryPath)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	if *existing != admissionFor(p) {
		return fmt.Errorf("%w: native admission owner changed", ErrInstallConflict)
	}
	// The caller has durably completed the receipt and journal cleanup. If
	// interrupted here, the same reviewed operation can retry just the cleanup.
	if err := s.checkpoint("native-journal-cleared"); err != nil {
		return err
	}
	root, err := os.OpenRoot(p.RepositoryPath)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := checkComponents(root, workspacegate.RecoveryMarker); err != nil {
		return err
	}
	if err := root.Remove(workspacegate.RecoveryMarker); err != nil {
		return err
	}
	return syncDir(root, path.Dir(workspacegate.RecoveryMarker))
}
