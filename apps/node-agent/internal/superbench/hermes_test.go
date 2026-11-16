//go:build unix

package superbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func hermesFixture(t *testing.T, mode string) (HermesConfig, hermesInput, string) {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "payload-home")
	for _, p := range []string{home, filepath.Join(home, ".hermes"), filepath.Join(home, "tmp")} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, ".hermes", "config.yaml"), []byte("# synthetic provider configuration\n"), 0600); err != nil {
		t.Fatal(err)
	}
	input := hermesInput{Binding: Binding{BoardID: "board", CardID: "card", RunID: "run", Epoch: 7}, Prompt: "fix the task"}
	result := WorkerResult{Version: GroupedWorkerVersion, Binding: input.Binding, Outcome: "complete", Handoff: map[string]string{"summary": "real child observed"}}
	raw, _ := json.Marshal(result)
	init := `{"type":"system","subtype":"init","model":"test-model","session_id":"","timestamp":1}` + "\n"
	event := map[string]any{"type": "result", "session_id": "session", "exit_code": 0, "text": string(raw), "tokens": map[string]int{"input": 1, "output": 2, "total": 3, "cache_read": 0, "cache_write": 0}, "duration_ms": 10, "timestamp": 2}
	switch mode {
	case "foreign":
		result.Binding.Epoch++
		raw, _ = json.Marshal(result)
		event["text"] = string(raw)
	case "prose":
		event["text"] = "I finished the task"
	case "error":
		event["error"] = "synthetic provider failure"
	case "replay-gap":
		event["replay_gap"] = true
	case "terminal-failure":
		event["exit_code"] = 1
	case "blocked":
		result.Outcome = "blocked"
		raw, _ = json.Marshal(result)
		event["text"] = string(raw)
	}
	terminal, _ := json.Marshal(event)
	output := init + string(terminal) + "\n"
	switch mode {
	case "partial":
		output = init
	case "truncated":
		output = strings.TrimSuffix(output, "\n")
	case "duplicate-terminal":
		output += string(terminal) + "\n"
	case "extra":
		output += "EXTRA\n"
	case "duplicate-key":
		output = init + `{"type":"result","type":"result"}` + "\n"
	case "large":
		output = init + strings.Repeat("x", maxHermesStream)
	}
	outputPath := filepath.Join(root, "events")
	if err := os.WriteFile(outputPath, []byte(output), 0600); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "hermes")
	// A real child with the exact argv and stream-json shapes read from Hermes
	// _parser.py/stream_json.py; this never contacts an inference service.
	body := `#!/bin/sh
set -eu
[ "$#" = 10 ]
[ "$1" = chat ] && [ "$2" = --query-file ] && [ "$3" = - ]
[ "$4" = --oneshot ] && [ "$5" = --format ] && [ "$6" = stream-json ]
[ "$7" = --provider ] && [ "$8" = test-provider ]
[ "$9" = --model ] && [ "${10}" = test-model ]
[ -z "${HUB_TOKEN+x}" ] && [ -z "${NODE_TOKEN+x}" ] && [ -z "${OPENAI_API_KEY+x}" ]
[ -z "${HERMES_KANBAN_TASK+x}" ] && [ -z "${LD_PRELOAD+x}" ]
[ "$HERMES_HOME" = "$HOME/.hermes" ] && [ "$TMPDIR" = "$HOME/tmp" ]
cat > "$HOME/query"
printf 'child log only\n' >&2
`
	if mode == "cancel" {
		body += "printf started > \"$HOME/started\"\nexec sleep 30\n"
	} else {
		body += "cat '" + outputPath + "'\n"
	}
	if mode == "nonzero" {
		body += "exit 4\n"
	}
	if err := os.WriteFile(script, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	return HermesConfig{Executable: script, Home: home, Provider: "test-provider", Model: "test-model"}, input, root
}

func TestHermesRealChildProtocolAndPrivateEnvironment(t *testing.T) {
	t.Setenv("HUB_TOKEN", "PRIVATE-HUB")
	t.Setenv("NODE_TOKEN", "PRIVATE-NODE")
	t.Setenv("OPENAI_API_KEY", "PRIVATE-PROVIDER")
	t.Setenv("HERMES_KANBAN_TASK", "foreign")
	t.Setenv("LD_PRELOAD", "private-loader")
	c, in, _ := hermesFixture(t, "complete")
	var out, logs bytes.Buffer
	if err := runHermes(t.Context(), in, &out, &logs, c); err != nil {
		t.Fatal(err)
	}
	var result WorkerResult
	if err := decodeGroupedResult(out.Bytes(), &result, in.Binding); err != nil || result.Outcome != "complete" {
		t.Fatalf("wrong result %v %s", err, out.Bytes())
	}
	query, err := os.ReadFile(filepath.Join(c.Home, "query"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{in.Prompt, `"epoch":7`, GroupedWorkerVersion, "blocked", "handoff"} {
		if !bytes.Contains(query, []byte(want)) {
			t.Fatalf("missing protocol instruction %q", want)
		}
	}
	if !strings.Contains(logs.String(), "child log only") || strings.Contains(out.String(), "child log") || strings.Contains(logs.String(), "PRIVATE") {
		t.Fatal("stdio/environment separation failed")
	}
}

func TestHermesRefusesFalseCompletion(t *testing.T) {
	for _, mode := range []string{"nonzero", "foreign", "prose", "error", "terminal-failure", "replay-gap", "partial", "truncated", "duplicate-terminal", "duplicate-key", "extra", "large"} {
		t.Run(mode, func(t *testing.T) {
			c, in, _ := hermesFixture(t, mode)
			var out, logs bytes.Buffer
			err := runHermes(t.Context(), in, &out, &logs, c)
			want := ErrHermesResult
			if mode == "nonzero" || mode == "large" {
				want = ErrHermesProcess
			}
			if !errors.Is(err, want) || out.Len() != 0 {
				t.Fatalf("wanted %v/no result, got %v/%s", want, err, out.Bytes())
			}
		})
	}
	c, in, _ := hermesFixture(t, "blocked")
	var out, logs bytes.Buffer
	if err := runHermes(t.Context(), in, &out, &logs, c); err != nil || !strings.Contains(out.String(), `"outcome":"blocked"`) {
		t.Fatalf("blocked observation lost: %v %s", err, out.Bytes())
	}
}

func TestHermesCancellationStopsLeaderWithoutResult(t *testing.T) {
	c, in, _ := hermesFixture(t, "cancel")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	var out, logs bytes.Buffer
	go func() { done <- runHermes(ctx, in, &out, &logs, c) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(c.Home, "started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child never started")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, ErrHermesProcess) || out.Len() != 0 {
			t.Fatalf("bad cancellation %v/%s", err, out.Bytes())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not stop child")
	}
}

func TestHermesStrictInputAndConfiguration(t *testing.T) {
	c, in, root := hermesFixture(t, "complete")
	good, _ := json.Marshal(in)
	for _, raw := range [][]byte{[]byte(`{}`), append(bytes.Clone(good), []byte(` {}`)...), []byte(`{"binding":{},"prompt":"a","prompt":"b"}`), []byte(`{"binding":null,"prompt":"x"}`), bytes.Replace(good, []byte(`"prompt":`), []byte(`"unknown":1,"prompt":`), 1), bytes.Repeat([]byte("x"), MaxWorker+1)} {
		if _, err := parseHermesInput(raw); !errors.Is(err, ErrHermesInput) {
			t.Fatalf("input accepted %v", err)
		}
	}
	if _, err := parseHermesInput(good); err != nil {
		t.Fatal(err)
	}
	var out, logs bytes.Buffer
	missing := c
	missing.Home = filepath.Join(root, "missing")
	if err := runHermes(t.Context(), in, &out, &logs, missing); !errors.Is(err, ErrHermesConfig) || out.Len() != 0 {
		t.Fatal("missing config did not refuse")
	}
	config := filepath.Join(c.Home, ".hermes", "config.yaml")
	if err := os.Chmod(config, 0644); err != nil {
		t.Fatal(err)
	}
	if err := runHermes(t.Context(), in, &out, &logs, c); !errors.Is(err, ErrHermesConfig) {
		t.Fatal("public config accepted")
	}
}

func TestHermesFiniteOwnedInput(t *testing.T) {
	c, in, _ := hermesFixture(t, "complete")
	raw, _ := json.Marshal(in)
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err = w.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	var out, logs bytes.Buffer
	if err := ExecuteHermesWorker(t.Context(), r, &out, &logs, c); err != nil {
		t.Fatal(err)
	}
	r, w, err = os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	if _, err := readHermesInput(ctx, r); !errors.Is(err, ErrHermesInput) {
		t.Fatalf("open input not bounded: %v", err)
	}
}
