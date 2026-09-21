package descriptor

import (
	"bufio"
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

const codexDiscoveryMaxFrame = 1 << 20

// codexACPDiscoverSkills starts the selected adapter with a new, disposable
// CODEX_HOME and an unreachable local provider. It sends only ACP initialize
// and session/new; it never creates a prompt or gives the adapter client tools.
func codexACPDiscoverSkills(ctx context.Context, adapter, workspace string) ([]string, error) {
	if adapter == "" || !filepath.IsAbs(adapter) || !filepath.IsAbs(workspace) {
		return nil, fmt.Errorf("invalid Codex discovery scope")
	}
	if _, err := os.Stat(workspace); err != nil {
		return nil, fmt.Errorf("workspace unavailable: %w", err)
	}
	home, err := os.MkdirTemp("", "agentpod-codex-skill-discovery-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(home)
	config := "model_provider = \"synthetic\"\nmodel = \"gpt-5.4\"\n[model_providers.synthetic]\nname = \"AgentPod offline skill discovery\"\nbase_url = \"http://127.0.0.1:9/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n"
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0600); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, adapter)
	cmd.Dir = workspace
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "CODEX_HOME=" + home, "NO_BROWSER=1", "LANG=C"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
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
		s.Buffer(make([]byte, 4096), codexDiscoveryMaxFrame+1)
		for s.Scan() {
			if len(s.Bytes()) > codexDiscoveryMaxFrame {
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
	if err := write(2, "session/new", map[string]any{"cwd": workspace, "mcpServers": []any{}}); err != nil {
		return nil, err
	}
	responses := map[float64]bool{}
	for {
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("ACP discovery deadline exceeded: %w", ctx.Err())
		case err := <-readErr:
			if err == nil {
				continue
			}
			return nil, fmt.Errorf("ACP output closed before discovery completed: %w", err)
		case e, ok := <-events:
			if !ok {
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
			}
			if e.Params.Update.SessionUpdate == "available_commands_update" {
				if !responses[1] || !responses[2] {
					return nil, fmt.Errorf("ACP announced commands before initialization completed")
				}
				names := make([]string, 0, len(e.Params.Update.AvailableCommands))
				for _, command := range e.Params.Update.AvailableCommands {
					if strings.HasPrefix(command.Name, "$") {
						names = append(names, strings.TrimPrefix(command.Name, "$"))
					}
				}
				sort.Strings(names)
				return names, nil
			}
		}
	}
}
