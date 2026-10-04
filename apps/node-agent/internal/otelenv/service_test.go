package otelenv

import (
	"errors"
	"testing"
)

func TestServicePathFromCgroup(t *testing.T) {
	const home = "/home/agentpod"
	for name, tc := range map[string]struct {
		cgroup string
		want   string
		err    error
	}{
		"v2 system unit": {
			cgroup: "0::/system.slice/agentpod-node.service\n",
			want:   SystemPath,
		},
		"v2 user unit": {
			cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentpod-node.service\n",
			want:   UserPath(home),
		},
		"v1 system unit": {
			cgroup: "12:pids:/system.slice/agentpod-node.service\n" +
				"5:cpu,cpuacct:/system.slice/agentpod-node.service\n" +
				"1:name=systemd:/system.slice/agentpod-node.service\n",
			want: SystemPath,
		},
		"v1 user unit": {
			cgroup: "12:pids:/user.slice/user-1001.slice/user@1001.service\n" +
				"1:name=systemd:/user.slice/user-1001.slice/user@1001.service/agentpod-node.service\n",
			want: UserPath(home),
		},
		"hybrid": {
			cgroup: "1:name=systemd:/system.slice/agentpod-node.service\n0::/system.slice/agentpod-node.service\n",
			want:   SystemPath,
		},
		"container v2 (cgroup namespace)": {cgroup: "0::/\n", err: ErrNotService},
		"docker v1": {
			cgroup: "12:pids:/docker/3f2a9c\n1:name=systemd:/docker/3f2a9c\n",
			err:    ErrNotService,
		},
		"tmux in a login session": {
			cgroup: "0::/user.slice/user-1000.slice/session-4.scope\n",
			err:    ErrNotService,
		},
		"tmux under the user manager": {
			cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-7c1e.scope\n",
			err:    ErrNotService,
		},
		"other unit": {cgroup: "0::/system.slice/ssh.service\n", err: ErrNotService},
		"lookalike":  {cgroup: "0::/system.slice/my-agentpod-node.service\n", err: ErrNotService},
		"empty":      {cgroup: "", err: ErrNotService},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := ServicePathFromCgroup(tc.cgroup, home)
			if tc.err != nil {
				if !errors.Is(err, tc.err) || got != "" {
					t.Fatalf("got %q, %v; want error %v", got, err, tc.err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestServicePathUserUnitNeedsHome(t *testing.T) {
	_, err := ServicePathFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentpod-node.service\n", "")
	if err == nil {
		t.Fatal("user unit without a home must be an error")
	}
}

func TestDaemonPathProbe(t *testing.T) {
	read := func(s string, err error) func(string) ([]byte, error) {
		return func(p string) ([]byte, error) {
			if p != "/proc/self/cgroup" {
				t.Fatalf("read %q", p)
			}
			return []byte(s), err
		}
	}
	if _, err := daemonPath("darwin", read("", nil), "/h"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("darwin: %v", err)
	}
	if p, err := daemonPath("linux", read("0::/system.slice/agentpod-node.service\n", nil), "/h"); err != nil || p != SystemPath {
		t.Fatalf("linux service: %q %v", p, err)
	}
	if _, err := daemonPath("linux", read("0::/\n", nil), "/h"); !errors.Is(err, ErrNotService) {
		t.Fatalf("container: %v", err)
	}
	if _, err := daemonPath("linux", read("", errors.New("EACCES")), "/h"); !errors.Is(err, ErrNotService) {
		t.Fatalf("unreadable cgroup must count as not-the-service: %v", err)
	}
}
