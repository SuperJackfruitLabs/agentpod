package hostproc

import (
	"encoding/json"
	"io"
	"os"
)

func PackageVersion(path, name string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	var p struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if json.NewDecoder(io.LimitReader(f, 64*1024)).Decode(&p) != nil || p.Name != name {
		return ""
	}
	return p.Version
}
