package otelenv

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tmpPath(t *testing.T) string {
	return filepath.Join(t.TempDir(), "sub", "otel.env")
}

func TestTemplateContent(t *testing.T) {
	tpl := Template()
	for _, want := range []string{
		"# OTEL_EXPORTER_OTLP_ENDPOINT=",
		"OTEL_SDK_DISABLED",
		"OTEL_TRACES_SAMPLER",
		"OTEL_EXPORTER_OTLP_HEADERS",
	} {
		if !strings.Contains(tpl, want) {
			t.Errorf("template missing %q", want)
		}
	}
	for _, line := range strings.Split(tpl, "\n") {
		if strings.TrimSpace(line) != "" && !strings.HasPrefix(line, "#") {
			t.Errorf("template has an active line by default: %q", line)
		}
	}
	st, err := Read(writeTemplate(t))
	if err != nil || st.Enabled || st.Endpoint != "" {
		t.Errorf("template state = %+v, %v; want disabled/empty", st, err)
	}
}

// The template is permanent once written (never overwritten), so what it claims about the
// SDK must be right: every documented "# KEY=" example is a known key and vice versa, and the
// keys the SDK does honour (resource attributes, the generic timeout for metrics) are not
// listed as ignored (verified against otel-go v1.47.0).
func TestTemplateDocumentsKnownKeys(t *testing.T) {
	tpl := Template()
	documented := map[string]bool{}
	for _, line := range strings.Split(tpl, "\n") {
		s := strings.TrimSpace(strings.TrimPrefix(line, "#"))
		if k, _, ok := strings.Cut(s, "="); ok && strings.HasPrefix(k, "OTEL_") && !strings.ContainsAny(k, " /*") {
			documented[k] = true
		}
	}
	for k := range knownKeys {
		if !documented[k] {
			t.Errorf("known key %s has no example line", k)
		}
	}
	for k := range documented {
		if !knownKeys[k] {
			t.Errorf("example line for unknown key %s", k)
		}
	}
	for _, want := range []string{
		"# OTEL_RESOURCE_ATTRIBUTES=",
		"OTEL_EXPORTER_OTLP_TIMEOUT also sets it",
	} {
		if !strings.Contains(tpl, want) {
			t.Errorf("template missing %q", want)
		}
	}
	if strings.Contains(tpl, "OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES") {
		t.Error("template still claims OTEL_RESOURCE_ATTRIBUTES is ignored")
	}
}

func writeTemplate(t *testing.T) string {
	p := tmpPath(t)
	if _, err := EnsureTemplate(p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestEnsureTemplateCreatesAndNeverOverwrites(t *testing.T) {
	p := tmpPath(t)
	wrote, err := EnsureTemplate(p)
	if err != nil || !wrote {
		t.Fatalf("first: wrote=%v err=%v", wrote, err)
	}
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o644 {
		t.Errorf("mode = %v", fi.Mode().Perm())
	}
	if err := os.WriteFile(p, []byte("OTEL_EXPORTER_OTLP_ENDPOINT=http://x:1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wrote, err = EnsureTemplate(p)
	if err != nil || wrote {
		t.Fatalf("second: wrote=%v err=%v", wrote, err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "OTEL_EXPORTER_OTLP_ENDPOINT=http://x:1\n" {
		t.Errorf("overwritten: %q", b)
	}
}

func TestReadStates(t *testing.T) {
	d := t.TempDir()
	st, err := Read(filepath.Join(d, "absent"))
	if err != nil || st.Enabled || st.Endpoint != "" {
		t.Errorf("absent: %+v %v", st, err)
	}
	cases := []struct {
		name, body string
		want       State
	}{
		{"set", "OTEL_EXPORTER_OTLP_ENDPOINT=http://h:4318\n", State{"http://h:4318", true}},
		{"quoted", "OTEL_EXPORTER_OTLP_ENDPOINT=\"http://h:4318/\"\n", State{"http://h:4318", true}},
		{"export prefix", "export OTEL_EXPORTER_OTLP_ENDPOINT=http://h:4318\n", State{"http://h:4318", true}},
		{"commented", "# OTEL_EXPORTER_OTLP_ENDPOINT=http://h:4318\n", State{"", false}},
		{"disabled", "OTEL_EXPORTER_OTLP_ENDPOINT=http://h:4318\nOTEL_SDK_DISABLED=true\n", State{"http://h:4318", false}},
		{"disabled false", "OTEL_EXPORTER_OTLP_ENDPOINT=http://h:4318\nOTEL_SDK_DISABLED=false\n", State{"http://h:4318", true}},
		{"last wins", "OTEL_EXPORTER_OTLP_ENDPOINT=http://a\nOTEL_EXPORTER_OTLP_ENDPOINT=http://b\n", State{"http://b", true}},
	}
	for _, c := range cases {
		p := filepath.Join(d, c.name)
		os.WriteFile(p, []byte(c.body), 0o644)
		got, err := Read(p)
		if err != nil || got != c.want {
			t.Errorf("%s: got %+v err %v want %+v", c.name, got, err, c.want)
		}
	}
}

func TestValidateEndpoint(t *testing.T) {
	good := []string{"http://127.0.0.1:4318", "https://otel.example.com", "http://host:4318/prefix", "HTTP://h"}
	for _, s := range good {
		if err := ValidateEndpoint(s); err != nil {
			t.Errorf("%q refused: %v", s, err)
		}
	}
	bad := []string{
		"", "   ", "ftp://h", "h:4318", "http://", "http:///x", "file:///etc/passwd",
		"http://h\nFOO=bar", "http://h\r\nFOO=bar", "http://h FOO=bar", "http://h\tx",
		"http://h/?a=b", "http://h=1", "http://h\x00", "http://h#frag", "http://u:p@h", "http://h\u2028x", "http://h\"",
		"http://h'", "http://h$X", "http://h`x`", "http://h\\x", "http://h#x",
	}
	for _, s := range bad {
		if err := ValidateEndpoint(s); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
}

func TestSetEndpointRoundTripAndChanged(t *testing.T) {
	p := writeTemplate(t)
	changed, err := SetEndpoint(p, "http://127.0.0.1:4318")
	if err != nil || !changed {
		t.Fatalf("set: %v %v", changed, err)
	}
	st, _ := Read(p)
	if st != (State{"http://127.0.0.1:4318", true}) {
		t.Errorf("state %+v", st)
	}
	changed, err = SetEndpoint(p, "http://127.0.0.1:4318")
	if err != nil || changed {
		t.Errorf("idempotent set: %v %v", changed, err)
	}
	// trailing slash is normalised so it is not a spurious change
	if changed, _ = SetEndpoint(p, "http://127.0.0.1:4318/"); changed {
		t.Errorf("trailing slash reported as change")
	}
	changed, _ = SetEndpoint(p, "https://otel.example.com")
	if !changed {
		t.Errorf("new endpoint not changed")
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "OTEL_TRACES_SAMPLER") || !strings.Contains(string(b), "OTEL_SDK_DISABLED") {
		t.Errorf("template comments lost:\n%s", b)
	}
	if n := strings.Count(string(b), "\nOTEL_EXPORTER_OTLP_ENDPOINT="); n != 1 {
		t.Errorf("want one active endpoint line, got %d:\n%s", n, b)
	}

	changed, err = Disable(p)
	if err != nil || !changed {
		t.Fatalf("disable: %v %v", changed, err)
	}
	st, _ = Read(p)
	if st.Enabled || st.Endpoint != "" {
		t.Errorf("after disable: %+v", st)
	}
	b, _ = os.ReadFile(p)
	if !strings.Contains(string(b), "# OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com") {
		t.Errorf("value not kept visible in comment:\n%s", b)
	}
	if changed, _ = Disable(p); changed {
		t.Errorf("second disable changed")
	}
	if changed, _ = SetEndpoint(p, "https://otel.example.com"); !changed {
		t.Errorf("re-enable not changed")
	}
	st, _ = Read(p)
	if !st.Enabled || st.Endpoint != "https://otel.example.com" {
		t.Errorf("re-enable: %+v", st)
	}
}

func TestSetEndpointOnAbsentCreatesFromTemplate(t *testing.T) {
	p := tmpPath(t)
	if changed, err := SetEndpoint(p, "http://h:1"); err != nil || !changed {
		t.Fatalf("%v %v", changed, err)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "OTEL_SDK_DISABLED") {
		t.Errorf("not from template")
	}
	p2 := tmpPath(t)
	if changed, err := Disable(p2); err != nil || changed {
		t.Errorf("disable absent: %v %v", changed, err)
	}
	if _, err := os.Stat(p2); err != nil {
		t.Errorf("disable should still create template: %v", err)
	}
}

func TestSetEndpointClearsSDKDisabled(t *testing.T) {
	p := tmpPath(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte("OTEL_SDK_DISABLED=true\n"), 0o644)
	if changed, err := SetEndpoint(p, "http://h:1"); err != nil || !changed {
		t.Fatal(changed, err)
	}
	st, _ := Read(p)
	if !st.Enabled {
		t.Errorf("OTEL_SDK_DISABLED=true survived enable: %+v", st)
	}
}

func TestRefusalLeavesFileUntouched(t *testing.T) {
	p := writeTemplate(t)
	if _, err := SetEndpoint(p, "http://h:1"); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(p)
	for _, s := range []string{"http://h\nEVIL=1", "http://h=1", "ftp://h", "http://h EVIL=1", ""} {
		changed, err := SetEndpoint(p, s)
		if err == nil || changed {
			t.Errorf("%q: changed=%v err=%v", s, changed, err)
		}
		after, _ := os.ReadFile(p)
		if string(after) != string(before) {
			t.Errorf("%q altered file", s)
		}
	}
	ents, _ := os.ReadDir(filepath.Dir(p))
	if len(ents) != 1 {
		t.Errorf("stray files: %v", ents)
	}
}

func TestAtomicRewriteModeAndTempCleanup(t *testing.T) {
	p := tmpPath(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(Template()), 0o600)
	if _, err := SetEndpoint(p, "http://h:1"); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o644 {
		t.Errorf("mode %v", fi.Mode().Perm())
	}
	ents, _ := os.ReadDir(filepath.Dir(p))
	if len(ents) != 1 || ents[0].Name() != "otel.env" {
		t.Errorf("temp not cleaned: %v", ents)
	}
	// rename failure (target is a directory) leaves no temp and reports error
	d := t.TempDir()
	target := filepath.Join(d, "otel.env")
	os.Mkdir(target, 0o755)
	os.WriteFile(filepath.Join(target, "x"), []byte("x"), 0o644)
	if _, err := SetEndpoint(target, "http://h:1"); err == nil {
		t.Errorf("expected error")
	}
	ents, _ = os.ReadDir(d)
	if len(ents) != 1 {
		t.Errorf("temp left behind: %v", ents)
	}
}

func TestSetEndpointPreservesOnlyKnownKeys(t *testing.T) {
	p := tmpPath(t)
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte("# note\nOTEL_EXPORTER_OTLP_ENDPOINT=http://old\nOTEL_TRACES_SAMPLER=always_off\n"), 0o644)
	if _, err := SetEndpoint(p, "http://new:1"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, _, _ := strings.Cut(line, "=")
		if !knownKeys[key] {
			t.Errorf("unknown active key %q", key)
		}
	}
	if !strings.Contains(string(b), "OTEL_TRACES_SAMPLER=always_off") {
		t.Errorf("operator tuning line dropped:\n%s", b)
	}
}

func TestErrUnsupportedIsSentinel(t *testing.T) {
	if !errors.Is(ErrUnsupported, ErrUnsupported) || ErrUnsupported.Error() == "" {
		t.Fatal("bad sentinel")
	}
}
