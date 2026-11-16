package superbench

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

type registeredCorpusCase struct {
	Name, Kind, Raw, SHA256 string
	HeaderHex               string `json:"header_hex"`
}
type registeredCorpus struct{ Valid, Invalid, Lexical []registeredCorpusCase }

func loadRegisteredCorpus(t *testing.T) registeredCorpus {
	t.Helper()
	raw, err := os.ReadFile("testdata/registered-worker.json")
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile("testdata/registered-worker-source.json")
	if err != nil {
		t.Fatal(err)
	}
	var pin struct{ Repository, Revision, Path, SHA256 string }
	if json.Unmarshal(source, &pin) != nil || pin.Repository != "ssh://git@forge.superjackfruit.com:2222/SuperJackfruitLabs/treaty.git" || pin.Revision != "094ebb69f369053008a20b0a311d1a88aebef988" || pin.Path != "fixtures/agentpod-local/registered-worker.json" || pin.SHA256 != "e2acd823e34631076e3dcf66cc1f0e306a9b95620ac3371a046ea39848367c13" {
		t.Fatal("registered corpus provenance changed")
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != pin.SHA256 {
		t.Fatal("vendored Treaty corpus differs from pinned bytes")
	}
	var corpus registeredCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Valid) != 7 || len(corpus.Invalid) != 29 || len(corpus.Lexical) != 6 {
		t.Fatal("shared corpus case inventory changed")
	}
	return corpus
}

func readCorpusCapsule(t *testing.T, frame []byte, digest string) (RegisteredCapsule, error) {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "owned-request")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err = file.Write(frame); err != nil {
		t.Fatal(err)
	}
	if _, err = file.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	return ReadRegisteredInput(t.Context(), file, digest)
}

// This executes the real producer codec and finite FD reader. It does not launch
// a payload or establish layout topology, source admission or fencing evidence.
func TestPinnedTreatyRegisteredWorkerCorpus(t *testing.T) {
	corpus := loadRegisteredCorpus(t)
	binding := Binding{BoardID: "brd_ABCDEF", CardID: "card_ABCDEF", RunID: "run_ABCDEF", Epoch: 7}
	for _, tc := range corpus.Valid {
		t.Run("valid/"+tc.Name, func(t *testing.T) {
			raw := []byte(tc.Raw)
			sum := sha256.Sum256(raw)
			if hex.EncodeToString(sum[:]) != tc.SHA256 {
				t.Fatal("shared SHA does not match actual raw bytes")
			}
			header, err := hex.DecodeString(tc.HeaderHex)
			if err != nil || len(header) != 4 {
				t.Fatal("bad shared BE32 header")
			}
			frame := append(bytes.Clone(header), raw...)
			if !bytes.Equal(frame, frameCapsule(raw)) {
				t.Fatal("shared BE32 differs from producer framing")
			}
			switch tc.Kind {
			case "capsule":
				c, err := ParseRegisteredCapsule(raw)
				if err != nil {
					t.Fatal(err)
				}
				encoded, err := c.Bytes()
				if err != nil || !bytes.Equal(encoded, raw) {
					t.Fatal("producer canonical bytes differ", err)
				}
				got, err := readCorpusCapsule(t, frame, tc.SHA256)
				if err != nil || got.Task.Binding != binding {
					t.Fatal("real request FD refused shared frame", err)
				}
			case "result":
				r, err := ParseRegisteredResult(frame, binding)
				if err != nil {
					t.Fatal(err)
				}
				var actual bytes.Buffer
				if err := WriteRegisteredResult(&actual, r); err != nil || !bytes.Equal(actual.Bytes(), frame) {
					t.Fatal("producer result frame differs", err)
				}
			default:
				t.Fatal("unknown shared case kind")
			}
		})
	}
	for _, tc := range append(corpus.Invalid, corpus.Lexical...) {
		t.Run("refuse/"+tc.Name, func(t *testing.T) {
			raw := []byte(tc.Raw)
			frame := frameCapsule(raw)
			switch tc.Kind {
			case "capsule":
				_, err := ParseRegisteredCapsule(raw)
				if !errors.Is(err, ErrRegisteredFrame) && !errors.Is(err, ErrRegisteredLayout) {
					t.Fatalf("expected registered codec refusal, got %v", err)
				}
				sum := sha256.Sum256(raw)
				_, err = readCorpusCapsule(t, frame, hex.EncodeToString(sum[:]))
				if !errors.Is(err, ErrRegisteredFrame) && !errors.Is(err, ErrRegisteredLayout) {
					t.Fatalf("finite reader accepted shared invalid bytes: %v", err)
				}
			case "result":
				if _, err := ParseRegisteredResult(frame, binding); !errors.Is(err, ErrRegisteredResult) {
					t.Fatalf("expected result refusal, got %v", err)
				}
			default:
				t.Fatal("unknown shared case kind")
			}
		})
	}
}

// Supplemental LOCAL characterization, not edits to the vendored canonical
// corpus. These characters are data; anchored identities still exclude them.
func TestRegisteredLocalControlCharacterVectors(t *testing.T) {
	for _, tc := range []struct {
		Char    rune
		Encoded string
	}{{1, `\u0001`}, {8, `\b`}, {12, `\f`}, {127, "\x7f"}} {
		t.Run(fmt.Sprintf("U+%04X", tc.Char), func(t *testing.T) {
			c := registeredCodecFixture(t)
			data := "data" + string(tc.Char)
			c.Task.Prompt = data
			c.Task.Arguments = append(c.Task.Arguments, data)
			c.Task.Environment["TERM"] = data
			raw, err := c.Bytes()
			if err != nil {
				t.Fatal("allowed task data refused", err)
			}
			if !bytes.Contains(raw, []byte(`"data`+tc.Encoded+`"`)) {
				t.Fatal("unexpected Go canonical control encoding")
			}
			if _, err := ParseRegisteredCapsule(raw); err != nil {
				t.Fatal(err)
			}
			result := WorkerResult{Version: GroupedWorkerVersion, Binding: c.Task.Binding, Outcome: "complete", Handoff: map[string]string{data: data}}
			var frame bytes.Buffer
			if err := WriteRegisteredResult(&frame, result); err != nil {
				t.Fatal(err)
			}
			got, err := ParseRegisteredResult(frame.Bytes(), c.Task.Binding)
			if err != nil || got.Handoff[data] != data {
				t.Fatal("allowed handoff data refused", err)
			}
			for _, field := range []string{"board", "layout-key", "inode"} {
				changed := registeredCodecFixture(t)
				expected := ErrRegisteredLayout
				switch field {
				case "board":
					changed.Task.Binding.BoardID += string(tc.Char)
					expected = ErrRegisteredFrame
				case "layout-key":
					changed.Layout.Key += string(tc.Char)
				case "inode":
					changed.Layout.Root.Inode += string(tc.Char)
				}
				invalid, err := json.Marshal(changed)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := ParseRegisteredCapsule(invalid); !errors.Is(err, expected) {
					t.Fatalf("%s wrong refusal: %v", field, err)
				}
			}
		})
	}
	// Preserve the narrower existing environment boundary; do not treat every
	// control character as equivalent to NUL, CR or LF.
	for _, bad := range []string{"\x00", "\r", "\n"} {
		c := registeredCodecFixture(t)
		c.Task.Environment["TERM"] = "data" + bad
		if _, err := c.Bytes(); !errors.Is(err, ErrRegisteredFrame) {
			t.Fatalf("environment %q accepted: %v", strings.TrimSpace(bad), err)
		}
	}
}
