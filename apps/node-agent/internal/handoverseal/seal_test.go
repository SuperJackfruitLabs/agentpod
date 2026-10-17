package handoverseal

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"
)

type vectorFile struct {
	PublicKey  string            `json:"public_key"`
	PrivateKey string            `json:"private_key"`
	Material   map[string]string `json:"material"`
	Envelope   string            `json:"envelope"`
}

func loadVector(t *testing.T) vectorFile {
	t.Helper()
	b, err := os.ReadFile("../../../../packages/contract/fixtures/handover-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func keypair(t *testing.T, v vectorFile) (pub, priv *[32]byte) {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(v.PrivateKey)
	if err != nil || len(raw) != 32 {
		t.Fatalf("bad vector private key: %v", err)
	}
	priv = new([32]byte)
	copy(priv[:], raw)
	pub = new([32]byte)
	curve25519.ScalarBaseMult(pub, priv)
	return
}

func open(t *testing.T, v vectorFile, envelope string) map[string]string {
	t.Helper()
	pub, priv := keypair(t, v)
	if !strings.HasPrefix(envelope, prefix) {
		t.Fatalf("envelope lacks prefix")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(envelope, prefix))
	if err != nil {
		t.Fatal(err)
	}
	plain, ok := box.OpenAnonymous(nil, raw, pub, priv)
	if !ok {
		t.Fatal("envelope did not open")
	}
	var m map[string]string
	if err := json.Unmarshal(plain, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestVectorPrivateKeyDerivesPublicKey(t *testing.T) {
	v := loadVector(t)
	pub, _ := keypair(t, v)
	got, err := ParsePublicKey(v.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if *got != *pub {
		t.Fatal("derived public key differs from recorded")
	}
}

func TestSealsMaterialThatTheVectorPrivateKeyOpens(t *testing.T) {
	v := loadVector(t)
	env, err := Seal(v.PublicKey, v.Material)
	if err != nil {
		t.Fatal(err)
	}
	if got := open(t, v, env); !reflect.DeepEqual(got, v.Material) {
		t.Fatalf("opened %v", got)
	}
}

func TestTwoSealsOfTheSameMaterialDiffer(t *testing.T) {
	v := loadVector(t)
	a, _ := Seal(v.PublicKey, v.Material)
	b, _ := Seal(v.PublicKey, v.Material)
	if a == "" || a == b {
		t.Fatal("seals must differ")
	}
}

func TestEnvelopeContainsNoPlaintext(t *testing.T) {
	v := loadVector(t)
	env, err := Seal(v.PublicKey, v.Material)
	if err != nil {
		t.Fatal(err)
	}
	token := v.Material["token"]
	if strings.Contains(env, token) {
		t.Fatal("plaintext in envelope string")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(env, prefix))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(token)) || bytes.Contains(raw, []byte(`"token"`)) {
		t.Fatal("plaintext in decoded envelope bytes")
	}
}

func TestRejectsEmbeddedNewlinesInAKey(t *testing.T) {
	v := loadVector(t)
	for _, k := range []string{v.PublicKey + "\n", prefix + "B6N8vBQgk8i3Vdwb\r\nEOhstCY3StFqqFPtC9_AsrhtHHw"} {
		if _, err := ParsePublicKey(k); err == nil {
			t.Fatalf("accepted %q", k)
		}
	}
}

func TestRejectsAKeyWithoutThePrefix(t *testing.T) {
	v := loadVector(t)
	bare := strings.TrimPrefix(v.PublicKey, prefix)
	if _, err := ParsePublicKey(bare); err == nil {
		t.Fatal("expected error")
	}
	if _, err := Seal(bare, v.Material); err == nil {
		t.Fatal("expected error")
	}
}

func TestRejectsWrongLength(t *testing.T) {
	v := loadVector(t)
	for _, n := range []int{31, 33} {
		k := prefix + base64.RawURLEncoding.EncodeToString(make([]byte, n))
		if _, err := ParsePublicKey(k); err == nil {
			t.Fatalf("len %d accepted", n)
		}
		if _, err := Seal(k, v.Material); err == nil {
			t.Fatalf("len %d sealed", n)
		}
	}
}

func TestRejectsBadBase64(t *testing.T) {
	v := loadVector(t)
	if _, err := ParsePublicKey(prefix + "!!!"); err == nil {
		t.Fatal("expected error")
	}
	if _, err := ParsePublicKey(v.PublicKey + "="); err == nil {
		t.Fatal("padded key accepted")
	}
}

func TestRejectsEmptyMaterial(t *testing.T) {
	v := loadVector(t)
	if _, err := Seal(v.PublicKey, nil); err == nil {
		t.Fatal("nil accepted")
	}
	if _, err := Seal(v.PublicKey, map[string]string{}); err == nil {
		t.Fatal("empty accepted")
	}
}

func TestOpensTheRecordedVectorEnvelopeToTheRecordedMaterial(t *testing.T) {
	v := loadVector(t)
	if got := open(t, v, v.Envelope); !reflect.DeepEqual(got, v.Material) {
		t.Fatalf("opened %v", got)
	}
}
