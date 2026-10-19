package mcpproxy

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestCredentialGenerationMigratesAndSurvivesRotationAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proxy.json")
	old := state{Listen: "127.0.0.1:12345", Secrets: map[string]string{"a": "old-offline-fixture-key"}}
	b, _ := json.Marshal(old)
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	s := OpenStore(path)
	if err := s.Ensure([]string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	key, generation, ok, err := s.SecretVersion("a")
	if err != nil || !ok || generation != 1 || key != old.Secrets["a"] {
		t.Fatal("legacy secret did not retain generation one")
	}
	if _, err := s.Rotate([]string{"a"}); err != nil {
		t.Fatal(err)
	}
	next, generation, ok, err := OpenStore(path).SecretVersion("a")
	if err != nil || !ok || generation != 2 || next == key {
		t.Fatal("rotation did not atomically replace credential and increment generation")
	}
	_, other, ok, err := OpenStore(path).SecretVersion("b")
	if err != nil || !ok || other != 1 {
		t.Fatal("unrotated credential generation changed")
	}
}

func TestIndependentStoreOwnersSerializeCredentialRotations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proxy.json")
	if err := OpenStore(path).Ensure([]string{"a"}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := OpenStore(path).Rotate([]string{"a"}); errs <- err }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	_, generation, ok, err := OpenStore(path).SecretVersion("a")
	if err != nil || !ok || generation != 17 {
		t.Fatalf("lost a serialized credential generation: got %d", generation)
	}
}

func TestProxyEntriesCarryGenerationOnlyAsPrivateNodeMetadata(t *testing.T) {
	p, _ := startAt(t, filepath.Join(t.TempDir(), "proxy.json"), "a")
	before := p.Servers("a")[0]
	if before.CredentialGeneration != 1 {
		t.Fatal("missing owned credential generation")
	}
	b, _ := json.Marshal(before)
	var wire map[string]any
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire) != 4 {
		t.Fatal("private generation metadata leaked into the ACP server declaration")
	}
	if _, err := p.Rotate([]string{"a"}); err != nil {
		t.Fatal(err)
	}
	after := p.Servers("a")[0]
	if after.CredentialGeneration != 2 || secretOf(after) == secretOf(before) {
		t.Fatal("proxy entry did not bind current key and generation")
	}
}

func TestInvalidCredentialGenerationFailsWithoutPublishingOrRotatingAKey(t *testing.T) {
	for _, generation := range []int64{-1, 0, 9007199254740992} {
		t.Run(fmt.Sprint(generation), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "proxy.json")
			b, _ := json.Marshal(map[string]any{"secrets": map[string]string{"a": "offline-test-credential"}, "generations": map[string]int64{"a": generation}})
			if err := os.WriteFile(path, b, 0600); err != nil {
				t.Fatal(err)
			}
			s := OpenStore(path)
			if _, _, _, err := s.SecretVersion("a"); err == nil {
				t.Fatal("invalid generation was published")
			}
			if _, err := s.Rotate([]string{"a"}); err == nil {
				t.Fatal("invalid generation was silently replaced")
			}
		})
	}
}
