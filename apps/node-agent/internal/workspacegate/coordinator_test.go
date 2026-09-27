package workspacegate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestOverlappingWorkspacesExcludePublicationButNotReaders(t *testing.T) {
	g := New()
	ctx := context.Background()
	root := t.TempDir()
	child := filepath.Join(root, "nested")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	a, err := g.Activity(ctx, child)
	if err != nil {
		t.Fatal(err)
	}
	b, err := g.Activity(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Exclusive(ctx, root); !errors.Is(err, ErrBusy) {
		t.Fatalf("active child allowed publication: %v", err)
	}
	a.Release()
	a.Release()
	if _, err := g.Exclusive(ctx, child); !errors.Is(err, ErrBusy) {
		t.Fatalf("active parent allowed publication: %v", err)
	}
	b.Release()
	p, err := g.Exclusive(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Release()
	for _, dir := range []string{root, child, filepath.Dir(root)} {
		if _, err := g.Activity(ctx, dir); !errors.Is(err, ErrBusy) {
			t.Fatalf("publication allowed activity at %s: %v", dir, err)
		}
		if _, err := g.Exclusive(ctx, dir); !errors.Is(err, ErrBusy) {
			t.Fatalf("publication allowed second writer at %s: %v", dir, err)
		}
	}
	other, err := g.Activity(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("unrelated workspace blocked: %v", err)
	}
	other.Release()
}

func TestAliasesAndRepositoryRenameRetainOverlap(t *testing.T) {
	g := New()
	ctx := context.Background()
	parent := t.TempDir()
	root := filepath.Join(parent, "project")
	child := filepath.Join(root, "nested")
	if err := os.MkdirAll(child, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(parent, "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	a, err := g.Activity(ctx, filepath.Join(alias, "nested"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Release()
	resolved, err := filepath.EvalSymlinks(child)
	if err != nil || a.Path() != resolved {
		t.Fatalf("spawn path must be canonical: %s %v", a.Path(), err)
	}
	if _, err := g.Exclusive(ctx, root); !errors.Is(err, ErrBusy) {
		t.Fatalf("alias bypassed reservation: %v", err)
	}
	renamed := filepath.Join(parent, "renamed")
	if err := os.Rename(root, renamed); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Exclusive(ctx, renamed); !errors.Is(err, ErrBusy) {
		t.Fatalf("inode identity lost on rename: %v", err)
	}
}

func TestCancellationAndInvalidPathsDoNotReserve(t *testing.T) {
	g := New()
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.Exclusive(ctx, root); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := g.Activity(context.Background(), filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing directory accepted")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Activity(context.Background(), file); err == nil {
		t.Fatal("non-directory accepted")
	}
	p, err := g.Exclusive(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	p.Release()
}

func TestSimultaneousStartAndPublicationHaveExactlyOneWinner(t *testing.T) {
	g := New()
	root := t.TempDir()
	for range 100 {
		start := make(chan struct{})
		var wg sync.WaitGroup
		leases := make([]*Lease, 2)
		errs := make([]error, 2)
		for i := range 2 {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				if i == 0 {
					leases[i], errs[i] = g.Activity(context.Background(), root)
				} else {
					leases[i], errs[i] = g.Exclusive(context.Background(), root)
				}
			}(i)
		}
		close(start)
		wg.Wait()
		if (errs[0] == nil) == (errs[1] == nil) {
			t.Fatalf("expected one winner: %v", errs)
		}
		for i, lease := range leases {
			if lease != nil {
				lease.Release()
			} else if !errors.Is(errs[i], ErrBusy) {
				t.Fatal(errs[i])
			}
		}
	}
}
