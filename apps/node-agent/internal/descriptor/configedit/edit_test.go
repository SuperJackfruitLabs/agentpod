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

// TestAppendToListCreatesAnAbsentKeyAndSurvivesContainment is the absent-key
// half of the additive-only story, and the normal state of a freshly
// provisioned station: Hermes does not write `command_allowlist` until an
// operator presses "Allow always", so a fleet baseline has to be able to
// CREATE the key.
//
// Before the fix, AppendToList produced a valid edit and SameOutsideKeys then
// rejected that very edit — `after` carried an empty list once the declared
// item was taken back out, `before` carried no key at all — so the whole plan
// refused with SHAPE_UNEXPECTED and nothing could be written for the station,
// including the reconcilable settings planned alongside it.
func TestAppendToListCreatesAnAbsentKeyAndSurvivesContainment(t *testing.T) {
	before := []byte("approvals:\n  timeout: 300\n  mode: ask\n")
	edited, action, added, err := AppendToList(before, "approvals.command_allowlist", []string{"git status"})
	if err != nil {
		t.Fatalf("AppendToList: %v", err)
	}
	if action != "append" || len(added) != 1 || added[0] != "git status" {
		t.Fatalf("action = %q, added = %#v", action, added)
	}
	if err := SameOutsideKeys(before, edited,
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": added}); err != nil {
		t.Fatalf("creating an absent additive-only key was rejected as a change outside the plan: %v", err)
	}
	v, present, err := Read(edited, "approvals.command_allowlist")
	if err != nil || !present {
		t.Fatalf("Read after create: present=%v err=%v", present, err)
	}
	if items, ok := v.([]any); !ok || len(items) != 1 || items[0] != "git status" {
		t.Fatalf("created list = %#v, want [git status]", v)
	}
}

// TestAppendToListFillsAnEmptyBlockListAndSurvivesContainment is the second
// shape of "the operator has nothing here": the key is written but holds no
// items, which is what a document looks like after the last entry is deleted.
func TestAppendToListFillsAnEmptyBlockListAndSurvivesContainment(t *testing.T) {
	before := []byte("approvals:\n  timeout: 300\n  command_allowlist:\n")
	edited, _, added, err := AppendToList(before, "approvals.command_allowlist", []string{"git status"})
	if err != nil {
		t.Fatalf("AppendToList: %v", err)
	}
	if err := SameOutsideKeys(before, edited,
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": added}); err != nil {
		t.Fatalf("filling an empty block list was rejected as a change outside the plan: %v", err)
	}
}

// The three fixes above widen a predicate, and spec §10 says a widened
// predicate must be mutation-tested — "a check that accepts more is exactly
// the change that can quietly stop checking". So: with the key absent in
// `before`, an edit that ALSO changes a key outside the plan must still be
// caught, and an edit that creates the key while dropping an operator entry
// from a DIFFERENT additive list must still be caught.
func TestTreatingAbsentAsEmptyStillCatchesAChangeElsewhere(t *testing.T) {
	before := []byte("approvals:\n  timeout: 300\n  mode: ask\n")
	edited, _, added, err := AppendToList(before, "approvals.command_allowlist", []string{"git status"})
	if err != nil {
		t.Fatal(err)
	}
	tampered, _, err := SetScalar(edited, "approvals.timeout", 900)
	if err != nil {
		t.Fatal(err)
	}
	if err := SameOutsideKeys(before, tampered,
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": added}); err == nil {
		t.Fatal("a created additive key let an unrelated change through — the guarantee is not guarding")
	}
}

// An additive-only key named in `additive` with NO added items is the
// strictest case, not a skipped one: nothing is removed from `after`, so an
// edit that dropped every entry the operator had must be caught. Were the key
// instead deleted from both documents (what a non-additive key gets), this
// would pass.
func TestAnAdditiveKeyThatAddedNothingStillComparesItsList(t *testing.T) {
	stripped := strings.Replace(doc, "    - ls\n", "", 1)
	if stripped == doc {
		t.Fatal("test setup: \"ls\" line not found to remove")
	}
	if err := SameOutsideKeys([]byte(doc), []byte(stripped),
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": nil}); err == nil {
		t.Fatal("an additive-only write that removed an operator entry and added nothing passed containment")
	}
}

// D5 again: a created key lands at the END of its section, so the keys the
// operator already wrote keep the order they were written in. Inserting
// immediately after the section's own line would reorder their document on
// every create.
func TestACreatedKeyLandsAfterTheKeysAlreadyThere(t *testing.T) {
	edited, action, err := SetScalar([]byte(doc), "approvals.new_setting", 1)
	if err != nil {
		t.Fatalf("SetScalar: %v", err)
	}
	if action != "create" {
		t.Fatalf("action = %q, want create", action)
	}
	out := string(edited)
	if !contains(out, "  new_setting: 1") {
		t.Fatalf("created key is not at its parent's indentation:\n%s", out)
	}
	if strings.Index(out, "new_setting") < strings.Index(out, "mode: ask") {
		t.Fatalf("a created key jumped ahead of keys the operator already had:\n%s", out)
	}
	// And it must still be INSIDE its own section, not after the next one.
	if strings.Index(out, "new_setting") > strings.Index(out, "model:") {
		t.Fatalf("a created key landed outside its own section:\n%s", out)
	}
	if err := SameOutsideKeys([]byte(doc), edited, []string{"approvals.new_setting"}, nil); err != nil {
		t.Fatalf("creating a key changed something else: %v", err)
	}
}

// Values that take more than one line, each as the LAST key of its section —
// which is where a created key is inserted. `yaml.Node` reports where a value
// STARTS and nothing about where it ends, and a multi-line scalar has no
// Content to walk, so an insertion point computed from the node tree alone
// lands in the middle of the operator's own text.
var multiLineSections = map[string]string{
	"a literal block with a blank line in it": "approvals:\n  timeout: 300\n  note: |\n    line one\n\n    line two\nmodel: gpt\n",
	"a folded block":                       "approvals:\n  timeout: 300\n  note: >\n    line one\n    line two\nmodel: gpt\n",
	"a multi-line plain scalar":            "approvals:\n  timeout: 300\n  note: first\n    second\nmodel: gpt\n",
	"a multi-line quoted scalar":           "approvals:\n  timeout: 300\n  note: \"first\n    second\"\nmodel: gpt\n",
	"a nested mapping":                     "approvals:\n  timeout: 300\n  nested:\n    deep: 1\n    deeper:\n      deepest: 2\nmodel: gpt\n",
	"a block sequence at its key's indent": "approvals:\n  timeout: 300\n  flat_list:\n  - git status\n  - ls\nmodel: gpt\n",
	"an indented block sequence":           "approvals:\n  timeout: 300\n  list:\n    - git status\n    - ls\nmodel: gpt\n",
}

// Important 1. A created key must land after the END of the last child, not
// after the line that child begins on. Before the fix the insert landed
// INSIDE the last value, which either destroyed it (`note: ""` plus
// `mode: "ask line one line two"`) or produced invalid YAML — and then
// containment refused the WHOLE plan, which is the amplification the
// absent-key fix was filed to remove.
func TestACreatedKeyLandsAfterAMultiLineValueNotInsideIt(t *testing.T) {
	for name, section := range multiLineSections {
		edited, action, err := SetScalar([]byte(section), "approvals.mode", "ask")
		if err != nil {
			t.Fatalf("%s: SetScalar: %v", name, err)
		}
		if action != "create" {
			t.Fatalf("%s: action = %q, want create", name, action)
		}
		out := string(edited)
		if !contains(out, "  mode: ask\n") {
			t.Fatalf("%s: created key is not at its parent's indentation:\n%s", name, out)
		}
		// Every line the operator wrote survives, in the order they wrote it:
		// the whole section up to `model:` is unchanged, with one line added.
		head := section[:strings.Index(section, "model: gpt")]
		if !contains(out, head) {
			t.Fatalf("%s: the operator's own lines were split by the insert:\n%s", name, out)
		}
		if strings.Index(out, "mode: ask") < strings.Index(out, "timeout: 300") {
			t.Fatalf("%s: a created key jumped ahead of keys the operator already had:\n%s", name, out)
		}
		if strings.Index(out, "mode: ask") > strings.Index(out, "model: gpt") {
			t.Fatalf("%s: a created key escaped its own section:\n%s", name, out)
		}
		// The whole point: containment passes, so one setting's shape does
		// not refuse every setting planned alongside it.
		if err := SameOutsideKeys([]byte(section), edited, []string{"approvals.mode"}, nil); err != nil {
			t.Fatalf("%s: creating a key changed something else: %v", name, err)
		}
	}
}

// The same rule for the list-creating path, which produced outright invalid
// YAML rather than a silently mangled scalar.
func TestAppendToListCreatesAKeyAfterAMultiLineValue(t *testing.T) {
	for name, section := range multiLineSections {
		edited, action, added, err := AppendToList([]byte(section), "approvals.command_allowlist", []string{"git status"})
		if err != nil {
			t.Fatalf("%s: AppendToList: %v", name, err)
		}
		if action != "append" || len(added) != 1 {
			t.Fatalf("%s: action/added = %q/%v", name, action, added)
		}
		out := string(edited)
		if !contains(out, "  command_allowlist:\n    - git status\n") {
			t.Fatalf("%s: created list is not whole at its parent's indentation:\n%s", name, out)
		}
		head := section[:strings.Index(section, "model: gpt")]
		if !contains(out, head) {
			t.Fatalf("%s: the operator's own lines were split by the insert:\n%s", name, out)
		}
		if strings.Index(out, "command_allowlist") > strings.Index(out, "model: gpt") {
			t.Fatalf("%s: a created list escaped its own section:\n%s", name, out)
		}
		if err := SameOutsideKeys([]byte(section), edited,
			[]string{"approvals.command_allowlist"},
			map[string][]string{"approvals.command_allowlist": added}); err != nil {
			t.Fatalf("%s: creating a list changed something else: %v", name, err)
		}
	}
}

// A blank line trailing the section is the operator's spacing, not part of
// the last value — the created key belongs above it, inside the section.
func TestACreatedKeyStopsAtABlankLineTrailingTheSection(t *testing.T) {
	doc := "approvals:\n  timeout: 300\n\nmodel: gpt\n"
	edited, _, err := SetScalar([]byte(doc), "approvals.mode", "ask")
	if err != nil {
		t.Fatalf("SetScalar: %v", err)
	}
	if out := string(edited); out != "approvals:\n  timeout: 300\n  mode: ask\n\nmodel: gpt\n" {
		t.Fatalf("a trailing blank line was swallowed:\n%q", out)
	}
}

// Minor 9. An inline (flow) mapping has no line of its own below it, so a
// child written on the next line falls outside the braces and the document
// stops parsing. Refused by name rather than written and then caught by
// containment as a whole-plan SHAPE_UNEXPECTED about the wrong thing.
func TestCreatingAKeyInAnInlineMappingIsRefusedByName(t *testing.T) {
	for _, doc := range []string{"approvals: {}\nmodel: gpt\n", "approvals: {timeout: 300}\n"} {
		if _, _, err := SetScalar([]byte(doc), "approvals.mode", "ask"); err == nil {
			t.Fatalf("an inline mapping was extended rather than refused: %q", doc)
		} else if !contains(err.Error(), "approvals") || !contains(err.Error(), "inline mapping") {
			t.Fatalf("refusal does not name the shape it refused: %v", err)
		}
		if _, _, _, err := AppendToList([]byte(doc), "approvals.command_allowlist", []string{"ls"}); err == nil {
			t.Fatalf("an inline mapping was extended by AppendToList: %q", doc)
		}
	}
}

// Important 2. `fmt.Sprint` renders a map as `map[a:1]`, a slice as `[1 2]`
// and a nil as `<nil>`, each of which parses back as a plain string. None of
// them is a value an operator or a harness asked for, so the writer refuses
// them itself — no caller is trusted to have checked.
func TestSetScalarRefusesAValueThatIsNotAScalar(t *testing.T) {
	for name, v := range map[string]any{
		"a map":   map[string]any{"a": 1},
		"a slice": []any{1, 2},
		"a null":  nil,
	} {
		edited, _, err := SetScalar([]byte(doc), "approvals.timeout", v)
		if err == nil {
			t.Fatalf("%s was written as a scalar:\n%s", name, string(edited))
		}
		if !contains(err.Error(), "approvals.timeout") {
			t.Fatalf("%s: a refusal must name the key it refused: %v", name, err)
		}
		if edited != nil {
			t.Fatalf("%s: a refused write still returned a document", name)
		}
	}
	if IsWritableScalar(map[string]any{"a": 1}) || IsWritableScalar(nil) || IsWritableScalar([]any{1}) {
		t.Fatal("IsWritableScalar accepted a non-scalar")
	}
	for _, v := range []any{"ask", 300, int64(300), 1.5, float64(300), true} {
		if !IsWritableScalar(v) {
			t.Fatalf("IsWritableScalar refused %#v, which this editor has always written", v)
		}
	}
}

// ---- an absent SECTION, not just an absent key -------------------------------

// noSectionDoc is the document this round exists for: an operator's own file
// with no `approvals:` key AT ALL. Every other fixture in this file has the
// section already there, which is exactly why the absent-SECTION case went
// unnoticed while the absent-KEY case was being fixed.
//
// It is the ordinary state of a freshly adopted station whose operator has
// customised nothing, and adopt-time reconcile — writing the fleet's declared
// values once, at adoption — is the headline use case for the whole feature.
// Refusing here refused on exactly the stations the feature exists for, and
// because derivePlanConfig refuses the WHOLE plan on one setting's shape, it
// also blocked every other setting declared alongside it.
const noSectionDoc = `# the operator's own note, which must survive
model:
  context_length: 8000   # trailing comment
  name: small
tools:
  - shell
  - search
`

func TestSetScalarCreatesAnAbsentSectionAtTheEndOfTheDocument(t *testing.T) {
	edited, action, err := SetScalar([]byte(noSectionDoc), "approvals.timeout", 900)
	if err != nil {
		t.Fatalf("an absent section was refused rather than created: %v", err)
	}
	if action != "create" {
		t.Fatalf("action = %q, want create", action)
	}
	// Appended at the END: every line the operator wrote survives, in order,
	// as a single unbroken prefix of the result.
	out := string(edited)
	if !strings.HasPrefix(out, noSectionDoc) {
		t.Fatalf("the operator's document was disturbed or reordered:\n%s", out)
	}
	if out != noSectionDoc+"approvals:\n  timeout: 900\n" {
		t.Fatalf("created section is not the one key, at the end:\n%q", out)
	}
	v, present, err := Read(edited, "approvals.timeout")
	if err != nil || !present {
		t.Fatalf("Read after creating the section: present=%v err=%v", present, err)
	}
	if v != 900 {
		t.Fatalf("timeout = %#v, want 900", v)
	}
	// And the created section is a change confined to the key the caller
	// named — the containment check must accept the edit the editor just made.
	if err := SameOutsideKeys([]byte(noSectionDoc), edited, []string{"approvals.timeout"}, nil); err != nil {
		t.Fatalf("creating a section was rejected as a change outside the plan: %v", err)
	}
}

func TestAppendToListCreatesAnAbsentSectionAtTheEndOfTheDocument(t *testing.T) {
	edited, action, added, err := AppendToList([]byte(noSectionDoc),
		"approvals.command_allowlist", []string{"git status", "ls"})
	if err != nil {
		t.Fatalf("an absent section was refused rather than created: %v", err)
	}
	if action != "append" || len(added) != 2 {
		t.Fatalf("action = %q, added = %#v, want append of both", action, added)
	}
	out := string(edited)
	if !strings.HasPrefix(out, noSectionDoc) {
		t.Fatalf("the operator's document was disturbed or reordered:\n%s", out)
	}
	if out != noSectionDoc+"approvals:\n  command_allowlist:\n    - git status\n    - ls\n" {
		t.Fatalf("created section is not the one list, at the end:\n%q", out)
	}
	v, present, err := Read(edited, "approvals.command_allowlist")
	if err != nil || !present {
		t.Fatalf("Read after creating the section: present=%v err=%v", present, err)
	}
	if items, ok := v.([]any); !ok || len(items) != 2 || items[0] != "git status" || items[1] != "ls" {
		t.Fatalf("created list = %#v, want [git status ls]", v)
	}
	if err := SameOutsideKeys([]byte(noSectionDoc), edited,
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": added}); err != nil {
		t.Fatalf("creating a section for an additive-only list was rejected as a change outside the plan: %v", err)
	}
}

// The whole-plan consequence, composed the way derivePlanConfig composes it:
// one setting in a section that EXISTS and one whose section is absent, edited
// in sequence against the same document, must both land and must pass
// containment TOGETHER. One absent section blocking every other setting in the
// same plan is what made this worth fixing rather than documenting.
func TestASettingInAnExistingSectionAndOneInAnAbsentSectionBothLand(t *testing.T) {
	keyPaths := []string{"model.context_length", "approvals.timeout"}
	after, action, err := SetScalar([]byte(noSectionDoc), keyPaths[0], 16000)
	if err != nil {
		t.Fatalf("%s: %v", keyPaths[0], err)
	}
	if action != "modify" {
		t.Fatalf("%s: action = %q, want modify", keyPaths[0], action)
	}
	after, action, err = SetScalar(after, keyPaths[1], 900)
	if err != nil {
		t.Fatalf("%s: %v", keyPaths[1], err)
	}
	if action != "create" {
		t.Fatalf("%s: action = %q, want create", keyPaths[1], action)
	}
	if v, _, _ := Read(after, keyPaths[0]); v != 16000 {
		t.Fatalf("%s = %#v, want 16000", keyPaths[0], v)
	}
	if v, _, _ := Read(after, keyPaths[1]); v != 900 {
		t.Fatalf("%s = %#v, want 900", keyPaths[1], v)
	}
	if err := SameOutsideKeys([]byte(noSectionDoc), after, keyPaths, nil); err != nil {
		t.Fatalf("a plan mixing an existing and an absent section was refused: %v", err)
	}
	// The operator's comment and the key they did not declare are still there.
	for _, want := range []string{"# the operator's own note, which must survive", "name: small", "  - search"} {
		if !contains(string(after), want) {
			t.Fatalf("a mixed plan reflowed the operator's file: %q is gone", want)
		}
	}
}

// Creating a section is ONLY for a section that is genuinely absent or
// genuinely bare. A section that is there in some OTHER shape this editor
// cannot extend keeps refusing exactly as it did before, by name — "make any
// shape work" is not what this change is. (The bare-key case moved to its own
// tests below, now that it is no longer refused.)
func TestASectionPresentInAnUnsupportedShapeIsStillRefusedByName(t *testing.T) {
	shapes := map[string]string{
		"a scalar":                           "approvals: 300\nmodel: gpt\n",
		"a sequence":                         "approvals:\n  - nope\nmodel: gpt\n",
		"an empty flow mapping":              "approvals: {}\nmodel: gpt\n",
		"a flow mapping":                     "approvals: {mode: ask}\nmodel: gpt\n",
		"a bare key with a trailing comment": "approvals: # nothing configured yet\nmodel: gpt\n",
	}
	for name, doc := range shapes {
		edited, _, err := SetScalar([]byte(doc), "approvals.timeout", 900)
		if err == nil {
			t.Fatalf("%s: a present section in an unsupported shape was written:\n%s", name, string(edited))
		}
		if !contains(err.Error(), "approvals") {
			t.Fatalf("%s: a refusal must name the section it refused: %v", name, err)
		}
		if edited != nil {
			t.Fatalf("%s: a refused write still returned a document", name)
		}
		edited, _, _, err = AppendToList([]byte(doc), "approvals.command_allowlist", []string{"ls"})
		if err == nil {
			t.Fatalf("%s: AppendToList wrote into a present section in an unsupported shape:\n%s", name, string(edited))
		}
		if !contains(err.Error(), "approvals") {
			t.Fatalf("%s: AppendToList's refusal must name the section: %v", name, err)
		}
	}
}

// Only ONE level of parent is ever created. A deeper absent path is out of
// scope — the registry has no such setting — so it is refused by the name of
// the element that is missing, not guessed at.
func TestADeeperAbsentPathIsStillRefusedByName(t *testing.T) {
	cases := map[string]struct{ doc, keyPath, missing string }{
		"both levels absent":  {"model: gpt\n", "approvals.nested.timeout", "approvals"},
		"second level absent": {"approvals:\n  mode: ask\n", "approvals.nested.timeout", "nested"},
	}
	for name, c := range cases {
		edited, _, err := SetScalar([]byte(c.doc), c.keyPath, 900)
		if err == nil {
			t.Fatalf("%s: a two-level create was guessed at:\n%s", name, string(edited))
		}
		if !contains(err.Error(), c.missing) {
			t.Fatalf("%s: refusal must name %q: %v", name, c.missing, err)
		}
		if _, _, _, err := AppendToList([]byte(c.doc), c.keyPath, []string{"ls"}); err == nil {
			t.Fatalf("%s: AppendToList guessed at a two-level create", name)
		}
	}
}

// Creating a section widens containment — `after` carries a section `before`
// did not have — and spec §10 says a widened predicate must be mutation
// tested. These are the F2 attack shapes a previous review ran, re-run now
// that SameOutsideKeys prunes a section the editor created: every one must
// still be REFUSED. The honest edits at the end must still pass, so a
// predicate that simply always errors fails this test too.
func TestF2AttackShapesStillRefusedNowThatACreatedSectionIsPruned(t *testing.T) {
	// A section that EXISTS, with entries the operator put there.
	lived := "# operator's note\n" +
		"approvals:\n  mode: ask\n  timeout: 300\n  command_allowlist:\n    - git status\n    - ls\n" +
		"tools:\n  - shell\n" +
		"model:\n  context_length: 8000\n"
	livedDup := strings.Replace(lived, "    - ls\n", "    - ls\n    - ls\n", 1)
	allow := "approvals.command_allowlist"

	type shape struct {
		before, after string
		keyPaths      []string
		additive      map[string][]string
	}
	// Every one of these must be refused.
	refused := map[string]shape{
		"drop-and-add: the operator's entry replaced by the declared one": {
			lived, strings.Replace(lived, "    - ls\n", "    - npm test\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"wipe to an empty list": {
			lived, strings.Replace(lived, "  command_allowlist:\n    - git status\n    - ls\n", "  command_allowlist: []\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"wipe to null": {
			lived, strings.Replace(lived, "  command_allowlist:\n    - git status\n    - ls\n", "  command_allowlist:\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"the key deleted outright": {
			lived, strings.Replace(lived, "  command_allowlist:\n    - git status\n    - ls\n", "", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"a duplicate the operator had silently dropped": {
			livedDup, strings.Replace(livedDup, "    - ls\n    - ls\n", "    - ls\n    - npm test\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"over-claimed added: an operator entry claimed as ours": {
			lived, strings.Replace(lived, "    - ls\n", "    - ls\n    - npm test\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test", "ls"}},
		},
		"an undeclared extra entry smuggled in": {
			lived, strings.Replace(lived, "    - ls\n", "    - ls\n    - npm test\n    - sudo rm\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"an unrelated list emptied": {
			lived, strings.Replace(strings.Replace(lived, "    - ls\n", "    - ls\n    - npm test\n", 1), "tools:\n  - shell\n", "tools: []\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"the whole section the operator wrote removed": {
			lived, strings.Replace(lived, "approvals:\n  mode: ask\n  timeout: 300\n  command_allowlist:\n    - git status\n    - ls\n", "", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		// Pruning must be asymmetric: only a section `before` genuinely
		// LACKED may be pruned out of `after`. Pruning an empty section on
		// BOTH sides would let an edit that deleted a whole section the
		// operator wrote — one holding only the key this plan names — pass as
		// "nothing outside the plan changed".
		"a section holding only this plan's key removed outright": {
			"# operator's note\napprovals:\n  timeout: 300\nmodel:\n  context_length: 8000\n",
			"# operator's note\nmodel:\n  context_length: 8000\n",
			[]string{"approvals.timeout"}, nil,
		},
		"another key in the same section changed": {
			lived, strings.Replace(strings.Replace(lived, "    - ls\n", "    - ls\n    - npm test\n", 1), "  mode: ask\n", "  mode: strict\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"an operator entry renamed rather than kept": {
			lived, strings.Replace(strings.Replace(lived, "    - ls\n", "    - lsx\n", 1), "    - git status\n", "    - git status\n    - npm test\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		// Created-section shapes: `before` has no section at all, so the
		// pruning this change adds is in play for every one of these.
		"a created section carrying an undeclared extra key": {
			noSectionDoc, noSectionDoc + "approvals:\n  command_allowlist:\n    - git status\n  mode: strict\n",
			[]string{allow}, map[string][]string{allow: {"git status"}},
		},
		"a created section's list carrying an undeclared extra entry": {
			noSectionDoc, noSectionDoc + "approvals:\n  command_allowlist:\n    - git status\n    - sudo rm\n",
			[]string{allow}, map[string][]string{allow: {"git status"}},
		},
		"a created section written while something else was dropped": {
			noSectionDoc,
			strings.Replace(noSectionDoc, "  - search\n", "", 1) + "approvals:\n  command_allowlist:\n    - git status\n",
			[]string{allow}, map[string][]string{allow: {"git status"}},
		},
		"a created section holding something other than what was declared": {
			noSectionDoc, noSectionDoc + "approvals:\n  command_allowlist:\n    - sudo rm\n",
			[]string{allow}, map[string][]string{allow: {"git status"}},
		},
	}
	for name, s := range refused {
		if s.after == s.before {
			t.Fatalf("%s: test setup produced no change to check", name)
		}
		if err := SameOutsideKeys([]byte(s.before), []byte(s.after), s.keyPaths, s.additive); err == nil {
			t.Fatalf("F2: containment accepted %q — the guarantee is not guarding:\n%s", name, s.after)
		}
	}

	// And the honest edits still pass, on both an existing and a created
	// section, so this test cannot be satisfied by refusing everything.
	honest := map[string]shape{
		"an append to a section that exists": {
			lived, strings.Replace(lived, "    - ls\n", "    - ls\n    - npm test\n", 1),
			[]string{allow}, map[string][]string{allow: {"npm test"}},
		},
		"an append that created the section": {
			noSectionDoc, noSectionDoc + "approvals:\n  command_allowlist:\n    - git status\n",
			[]string{allow}, map[string][]string{allow: {"git status"}},
		},
		"a scalar written into a created section": {
			noSectionDoc, noSectionDoc + "approvals:\n  timeout: 900\n",
			[]string{"approvals.timeout"}, nil,
		},
	}
	for name, s := range honest {
		if err := SameOutsideKeys([]byte(s.before), []byte(s.after), s.keyPaths, s.additive); err != nil {
			t.Fatalf("containment refused %q, which is the edit the editor itself makes: %v", name, err)
		}
	}
}

// Two document shapes an append has to cope with before it can create a
// section: a document that is empty, and one whose last line has no newline
// after it (where appending blind would glue the section onto that line and
// destroy it).
// ---- a bare SECTION, present but holding nothing --------------------------

// bareSectionDoc is a document whose `approvals:` key is present but holds
// nothing — the same amplification this round exists to fix, arriving
// through a different door than an absent section: `derivePlanConfig`
// refuses the WHOLE plan on this one setting's shape today, exactly as it
// once did for an absent section.
const bareSectionDoc = "# the operator's own note, which must survive\napprovals:\nmodel: gpt\n"

func TestSetScalarExtendsABareSectionInPlace(t *testing.T) {
	edited, action, err := SetScalar([]byte(bareSectionDoc), "approvals.timeout", 900)
	if err != nil {
		t.Fatalf("a bare section was refused rather than extended: %v", err)
	}
	if action != "create" {
		t.Fatalf("action = %q, want create", action)
	}
	out := string(edited)
	want := "# the operator's own note, which must survive\napprovals:\n  timeout: 900\nmodel: gpt\n"
	if out != want {
		t.Fatalf("extended bare section = %q, want %q", out, want)
	}
	v, present, err := Read(edited, "approvals.timeout")
	if err != nil || !present || v != 900 {
		t.Fatalf("Read after extending the bare section: %#v present=%v err=%v", v, present, err)
	}
	if err := SameOutsideKeys([]byte(bareSectionDoc), edited, []string{"approvals.timeout"}, nil); err != nil {
		t.Fatalf("extending a bare section was rejected as a change outside the plan: %v", err)
	}
}

func TestAppendToListExtendsABareSectionInPlace(t *testing.T) {
	edited, action, added, err := AppendToList([]byte(bareSectionDoc), "approvals.command_allowlist", []string{"git status", "ls"})
	if err != nil {
		t.Fatalf("a bare section was refused rather than extended: %v", err)
	}
	if action != "append" || len(added) != 2 {
		t.Fatalf("action = %q, added = %#v, want append of both", action, added)
	}
	out := string(edited)
	want := "# the operator's own note, which must survive\napprovals:\n  command_allowlist:\n    - git status\n    - ls\nmodel: gpt\n"
	if out != want {
		t.Fatalf("extended bare section = %q, want %q", out, want)
	}
	if err := SameOutsideKeys([]byte(bareSectionDoc), edited,
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": added}); err != nil {
		t.Fatalf("extending a bare section for an additive-only list was rejected as a change outside the plan: %v", err)
	}
}

// The insertion point is the KEY's own line, never wherever a null value
// node happens to report its line as — which, for an implicit null with
// nothing after the colon, can be the NEXT sibling's line. A bare header
// immediately followed by other top-level content is the shape that would
// expose that bug: inserting at the wrong line would land the new key
// AFTER the sibling, outside the section entirely, rather than inside it.
func TestABareHeaderFollowedByOtherContentInsertsInsideItsOwnSection(t *testing.T) {
	doc := "approvals:\ntimeout: 30\n"
	edited, action, err := SetScalar([]byte(doc), "approvals.mode", "ask")
	if err != nil {
		t.Fatalf("SetScalar: %v", err)
	}
	if action != "create" {
		t.Fatalf("action = %q, want create", action)
	}
	want := "approvals:\n  mode: ask\ntimeout: 30\n"
	if out := string(edited); out != want {
		t.Fatalf("got %q, want %q — the created key must land inside approvals, before the sibling key", out, want)
	}
}

// A multi-setting plan mixing a bare section and a normal one, composed the
// way derivePlanConfig composes it: both must land and both must pass
// containment TOGETHER, so one bare section does not block a setting
// declared alongside it in a different section.
func TestASettingInABareSectionAndOneInAnExistingSectionBothLand(t *testing.T) {
	before := "approvals:\nmodel:\n  context_length: 8000\n"
	keyPaths := []string{"approvals.timeout", "model.context_length"}
	after, action, err := SetScalar([]byte(before), keyPaths[0], 900)
	if err != nil {
		t.Fatalf("%s: %v", keyPaths[0], err)
	}
	if action != "create" {
		t.Fatalf("%s: action = %q, want create", keyPaths[0], action)
	}
	after, action, err = SetScalar(after, keyPaths[1], 16000)
	if err != nil {
		t.Fatalf("%s: %v", keyPaths[1], err)
	}
	if action != "modify" {
		t.Fatalf("%s: action = %q, want modify", keyPaths[1], action)
	}
	if err := SameOutsideKeys([]byte(before), after, keyPaths, nil); err != nil {
		t.Fatalf("a plan mixing a bare section and an existing one was refused: %v", err)
	}
}

// F2 again, on the new widening: pruning a bare section must be asymmetric.
// Only a section `before` genuinely left bare may be pruned; an edit that
// quietly dropped operator entries alongside filling the bare section must
// still be caught.
func TestF2StillCatchesAChangeElsewhereWhenASectionWasBare(t *testing.T) {
	before := "approvals:\ntools:\n  - shell\n  - search\n"
	edited, _, _, err := AppendToList([]byte(before), "approvals.command_allowlist", []string{"git status"})
	if err != nil {
		t.Fatal(err)
	}
	tampered := strings.Replace(string(edited), "tools:\n  - shell\n  - search\n", "tools: []\n", 1)
	if tampered == string(edited) {
		t.Fatal("test setup: tools list not found to empty")
	}
	if err := SameOutsideKeys([]byte(before), []byte(tampered),
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": {"git status"}}); err == nil {
		t.Fatal("F2: containment accepted a bare-section fill alongside an unrelated list being emptied")
	}
}

func TestCreatingASectionCopesWithAnEmptyOrUnterminatedDocument(t *testing.T) {
	cases := map[string]string{
		"an empty document":               "",
		"no trailing newline":             "model:\n  context_length: 8000",
		"a trailing comment of their own": "model:\n  context_length: 8000\n# the operator's closing note\n",
	}
	for name, before := range cases {
		edited, action, err := SetScalar([]byte(before), "approvals.timeout", 900)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if action != "create" {
			t.Fatalf("%s: action = %q, want create", name, action)
		}
		if !contains(string(edited), "approvals:\n  timeout: 900\n") {
			t.Fatalf("%s: the created section is not whole:\n%q", name, string(edited))
		}
		v, present, err := Read(edited, "approvals.timeout")
		if err != nil || !present || v != 900 {
			t.Fatalf("%s: the result does not read back: %#v present=%v err=%v", name, v, present, err)
		}
		if err := SameOutsideKeys([]byte(before), edited, []string{"approvals.timeout"}, nil); err != nil {
			t.Fatalf("%s: creating the section changed something else: %v", name, err)
		}
	}
}
