package main

import (
	"bytes"
	"os"
	"testing"
)

func TestHermesModeRequiresExplicitArgumentsAndPrivateConfiguration(t *testing.T) {
	for _, args := range [][]string{{"--unknown=PRIVATE"}, {"extra"}, {"--help"}} {
		var out, logs bytes.Buffer
		if code := entryInput(append([]string{"hermes-v1"}, args...), nil, &out, &logs); code != 2 || out.Len() != 0 || logs.String() != "Hermes worker refused: arguments\n" {
			t.Fatalf("bad argument refusal %d %q %q", code, out.String(), logs.String())
		}
	}
	in, err := os.CreateTemp(t.TempDir(), "input")
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	raw := `{"binding":{"board_id":"b","card_id":"c","run_id":"r","epoch":1},"prompt":"p"}`
	if _, err = in.WriteString(raw); err != nil {
		t.Fatal(err)
	}
	if _, err = in.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	var out, logs bytes.Buffer
	if code := entryInput([]string{"hermes-v1"}, in, &out, &logs); code != 1 || out.Len() != 0 || logs.String() != "Hermes worker refused: configuration\n" {
		t.Fatalf("missing config %d %q %q", code, out.String(), logs.String())
	}
}
