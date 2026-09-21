package descriptor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const acpDiscoveryMaxFrame = 1 << 20

// discoverACPSkillCommands starts a resolved ACP adapter, sends only
// initialize and session/new, then returns the slash-command names that the
// new session advertises. It never creates a prompt or supplies client tools.
// Callers establish each harness's version, authentication, and environment
// evidence before selecting this probe.
func discoverACPSkillCommands(ctx context.Context, argv []string, workspace string, env []string, normalize func(string) (string, bool)) ([]string, error) {
	if len(argv) == 0 || argv[0] == "" || !filepath.IsAbs(argv[0]) || !filepath.IsAbs(workspace) {
		return nil, fmt.Errorf("invalid ACP discovery scope")
	}
	if normalize == nil {
		return nil, fmt.Errorf("ACP discovery needs a command-name mapping")
	}
	if _, err := os.Stat(workspace); err != nil {
		return nil, fmt.Errorf("workspace unavailable: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = workspace
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		in.Close()
		return nil, err
	}
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		finished := make(chan struct{})
		go func() { _ = cmd.Wait(); close(finished) }()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-finished
		}
		_ = in.Close()
	}()

	type event struct {
		ID     any    `json:"id"`
		Method string `json:"method"`
		Params struct {
			Update struct {
				SessionUpdate     string `json:"sessionUpdate"`
				AvailableCommands []struct {
					Name string `json:"name"`
				} `json:"availableCommands"`
			} `json:"update"`
		} `json:"params"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	events := make(chan event, 32)
	readErr := make(chan error, 1)
	go func() {
		defer close(events)
		s := bufio.NewScanner(out)
		s.Buffer(make([]byte, 4096), acpDiscoveryMaxFrame+1)
		for s.Scan() {
			if len(s.Bytes()) > acpDiscoveryMaxFrame {
				readErr <- fmt.Errorf("ACP frame exceeds discovery limit")
				return
			}
			var e event
			if err := json.Unmarshal(s.Bytes(), &e); err != nil {
				readErr <- fmt.Errorf("ACP returned invalid JSON")
				return
			}
			select {
			case events <- e:
			case <-ctx.Done():
				return
			}
		}
		if err := s.Err(); err != nil {
			readErr <- err
			return
		}
		readErr <- io.EOF
	}()
	stderrSummary := func() string {
		// Adapters occasionally describe a startup/configuration refusal only on
		// stderr. Keep that evidence compact and one-line before it reaches the
		// hub's separately bounded, path-scrubbing diagnostic boundary.
		message := strings.Join(strings.Fields(stderr.String()), " ")
		if len(message) > 400 {
			message = message[:400] + "…"
		}
		return message
	}
	write := func(id int, method string, params any) error {
		frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		if err != nil {
			return err
		}
		_, err = in.Write(append(frame, '\n'))
		return err
	}
	if err := write(1, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]string{"name": "agentpod-native-skill-verifier", "version": "1"}}); err != nil {
		return nil, err
	}
	responses := map[float64]bool{}
	sessionRequested := false
	for {
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("ACP discovery deadline exceeded: %w", ctx.Err())
		case err, ok := <-readErr:
			// The scanner can observe EOF before the buffered events channel is
			// drained. Keep consuming those already-read frames; a command update
			// in that buffer is still valid discovery evidence. A non-EOF reader
			// error remains terminal because its stream may be incomplete.
			if !ok || err == io.EOF {
				readErr = nil
				continue
			}
			return nil, fmt.Errorf("ACP output closed before discovery completed: %w", err)
		case e, ok := <-events:
			if !ok {
				if summary := stderrSummary(); summary != "" {
					return nil, fmt.Errorf("ACP output closed before discovery completed: %s", summary)
				}
				return nil, fmt.Errorf("ACP output closed before discovery completed")
			}
			if e.Method != "" && e.ID != nil {
				return nil, fmt.Errorf("ACP requested an unsupported client action")
			}
			if e.ID != nil {
				id, ok := e.ID.(float64)
				if !ok || (id != 1 && id != 2) || len(e.Error) != 0 || len(e.Result) == 0 {
					return nil, fmt.Errorf("ACP discovery request failed")
				}
				responses[id] = true
				// ACP initialization is a handshake.  Some adapters begin their
				// session setup as soon as they answer it and can close their
				// transport when session/new arrives before that response.  Keep
				// the probe protocol-correct and send the dependent request only
				// after initialization is acknowledged.
				if id == 1 && !sessionRequested {
					if err := write(2, "session/new", map[string]any{"cwd": workspace, "mcpServers": []any{}}); err != nil {
						return nil, err
					}
					sessionRequested = true
				}
			}
			if e.Params.Update.SessionUpdate == "available_commands_update" {
				if !responses[1] || !responses[2] {
					return nil, fmt.Errorf("ACP announced commands before initialization completed")
				}
				names := make([]string, 0, len(e.Params.Update.AvailableCommands))
				for _, command := range e.Params.Update.AvailableCommands {
					if name, ok := normalize(command.Name); ok {
						names = append(names, name)
					}
				}
				sort.Strings(names)
				return names, nil
			}
		}
	}
}
