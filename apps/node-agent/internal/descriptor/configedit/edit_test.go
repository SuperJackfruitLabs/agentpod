package configedit

import (
	"strings"
	"testing"
)

const doc = `# the operator's own note, which must survive
approvals:
  mode: ask        # trailing comment
  timeout: 300
  command_allowlist:
    - git status
    - ls
model:
  context_length: 8000
`

func contains(s, substr string) bool { return strings.Contains(s, substr) }

func TestReadSeesAListRatherThanCallingItAbsent(t *testing.T) {
	v, present, err := Read([]byte(doc), "approvals.command_allowlist")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !present {
		t.Fatal("a present list read as absent — the exact false negative this fixes")
	}
	items, ok := v.([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("want a 2-item list, got %#v", v)
	}
}

func TestReadDistinguishesAbsentFromPresent(t *testing.T) {
	if _, present, _ := Read([]byte(doc), "approvals.nothing_here"); present {
		t.Fatal("a key that is not there reported present")
	}
	if _, present, _ := Read([]byte(doc), "approvals.timeout"); !present {
		t.Fatal("a present scalar reported absent")
	}
}

func TestReadOnAnUnparseableDocumentErrorsRatherThanReportingAbsent(t *testing.T) {
	_, present, err := Read([]byte("approvals:\n\t\tbroken: [unclosed\n"), "approvals.timeout")
	if err == nil {
		t.Fatal("an unparseable document must error, never report absent")
	}
	if present {
		t.Fatal("present must be false when the document could not be parsed")
	}
}

func TestSetScalarChangesOneValueAndNothingElse(t *testing.T) {
	edited, action, err := SetScalar([]byte(doc), "approvals.timeout", 900)
	if err != nil {
		t.Fatalf("SetScalar: %v", err)
	}
	if action != "modify" {
		t.Fatalf("action = %q, want modify", action)
	}
	if err := SameOutsideKeys([]byte(doc), edited, []string{"approvals.timeout"}, nil); err != nil {
		t.Fatalf("something outside approvals.timeout changed: %v", err)
	}
	if got, _, _ := Read(edited, "approvals.timeout"); got != 900 {
		t.Fatalf("timeout = %#v, want 900", got)
	}
}

func TestAnOperatorsCommentsOrderAndIndentationSurvive(t *testing.T) {
	edited, _, err := SetScalar([]byte(doc), "approvals.timeout", 900)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"# the operator's own note, which must survive",
		"mode: ask        # trailing comment",
		"  context_length: 8000",
	} {
		if !contains(string(edited), want) {
			t.Fatalf("a write reflowed the operator's file: %q is gone", want)
		}
	}
}

// This is F2's test, and the most important one in the file.
func TestAppendToListKeepsEveryEntryTheOperatorAlreadyHad(t *testing.T) {
	edited, action, added, err := AppendToList([]byte(doc), "approvals.command_allowlist",
		[]string{"git status", "npm test"})
	if err != nil {
		t.Fatalf("AppendToList: %v", err)
	}
	if action != "append" {
		t.Fatalf("action = %q, want append", action)
	}
	// "git status" was already there and must not be duplicated; "ls" was the
	// operator's and must not be removed.
	if len(added) != 1 || added[0] != "npm test" {
		t.Fatalf("added = %#v, want only [npm test]", added)
	}
	v, _, _ := Read(edited, "approvals.command_allowlist")
	items := v.([]any)
	if len(items) != 3 {
		t.Fatalf("want 3 entries (ls kept, git status not duplicated, npm test added), got %#v", items)
	}
	var sawLS bool
	for _, it := range items {
		if it == "ls" {
			sawLS = true
		}
	}
	if !sawLS {
		t.Fatal("an additive-only write removed an operator's entry — F2's worst outcome")
	}
}

func TestAppendToListNeverRemoves(t *testing.T) {
	// Declaring a list that does NOT contain the operator's entry must still keep it.
	edited, _, _, err := AppendToList([]byte(doc), "approvals.command_allowlist", []string{"npm test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := SameOutsideKeys([]byte(doc), edited,
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": {"npm test"}}); err != nil {
		t.Fatalf("an additive write changed more than it added: %v", err)
	}

	// The happy path above proves nothing about SameOutsideKeys's ability to
	// CATCH a violation — a predicate that always returns nil would pass it
	// too. So also feed it a document where the operator's own entry ("ls")
	// was removed in addition to the declared add, and require an error.
	tampered := strings.Replace(string(edited), "    - ls\n", "", 1)
	if tampered == string(edited) {
		t.Fatal("test setup: \"ls\" line not found to remove")
	}
	if err := SameOutsideKeys([]byte(doc), []byte(tampered),
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": {"npm test"}}); err == nil {
		t.Fatal("SameOutsideKeys passed a document where an operator's own list entry was removed")
	}
}

func TestSameOutsideKeysCatchesAChangeElsewhere(t *testing.T) {
	tampered, _, _ := SetScalar([]byte(doc), "model.context_length", 16000)
	if err := SameOutsideKeys([]byte(doc), tampered, []string{"approvals.timeout"}, nil); err == nil {
		t.Fatal("SameOutsideKeys passed a document whose other key changed — the guarantee is not guarding")
	}
}

func TestSetScalarRefusesAShapeItDoesNotKnow(t *testing.T) {
	// approvals is a list here, not a mapping.
	_, _, err := SetScalar([]byte("approvals:\n  - nope\n"), "approvals.timeout", 900)
	if err == nil {
		t.Fatal("writing into an unexpected shape must be refused")
	}
}
