package benchdispatch

import (
	"context"
	"reflect"
)

// ReservedSourceSpec recovers only an exact already-recorded attempt under the
// journal lock. It does not decide Create, authorize disclosure, or grant a run.
func (s Store) ReservedSourceSpec(ctx context.Context, key string, identity Identity) (SourceSpec, error) {
	var result SourceSpec
	err := s.withDocument(ctx, key, false, func(doc *state) (bool, error) {
		var found *SourceSpec
		selectSpec := func(spec SourceSpec) error {
			if !reflect.DeepEqual(spec.Identity, identity) {
				return nil
			}
			if found != nil {
				return ErrInvalid
			}
			copy := spec
			copy.Repositories = append([]SourceRepository(nil), spec.Repositories...)
			found = &copy
			return nil
		}
		if doc.Source != nil {
			if e := selectSpec(doc.Source.Spec); e != nil {
				return false, e
			}
		}
		for _, r := range doc.Records {
			if r.Source != nil {
				if e := selectSpec(r.Source.Spec); e != nil {
					return false, e
				}
			}
		}
		if found == nil {
			return false, ErrOwner
		}
		result = *found
		return false, nil
	})
	if err != nil {
		return SourceSpec{}, err
	}
	return result, nil
}
