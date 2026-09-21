package main

// fleet skills — the operator CLI for the same reviewed catalog and canary
// protocol exposed by the Console.  It deliberately prints the hub's complete
// JSON replies: plans and receipts are review evidence, not data to summarize
// away in a convenience client.

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

func fleetSkills(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(`Usage: fleet skills <verb>

  fleet skills artifacts
  fleet skills artifact delete --id ARTIFACT_ID
  fleet skills releases
  fleet skills cohorts
  fleet skills upload --harness H --profile P ARCHIVE.tgz
  fleet skills release import RELEASE.json
  fleet skills cohort create --release ID --digest SHA256 --station ID
  fleet skills canary plan --cohort ID --release ID --digest SHA256 --station ID
  fleet skills canary inspect --cohort ID --release ID --digest SHA256 --station ID --operation ID
  fleet skills canary apply --cohort ID --release ID --digest SHA256 --station ID --operation ID --plan-digest SHA256
  fleet skills station verify --station ID --profile PROFILE
  fleet skills station rollback-plan --station ID --profile PROFILE
  fleet skills station inspect --station ID --operation ID
  fleet skills station apply --station ID --operation ID --plan-digest SHA256
  fleet skills native plan --station ID --profile PROFILE --action activate|deactivate|rollback
  fleet skills native inspect --station ID --operation ID
  fleet skills native apply --station ID --operation ID --plan-digest SHA256
  fleet skills native verify --station ID --profile PROFILE

Every mutation returns the hub's reviewed record. Read that response before an
apply command; this CLI never turns a plan into an implicit apply.`)
		return
	}
	switch args[0] {
	case "artifacts":
		fleetGet("/api/skills/artifacts", args[1:])
	case "artifact":
		fleetSkillArtifact(args[1:])
	case "releases":
		fleetGet("/api/skills/catalog/releases", args[1:])
	case "cohorts":
		fleetGet("/api/skills/catalog/cohorts", args[1:])
	case "upload":
		fleetSkillUpload(args[1:])
	case "release":
		fleetSkillRelease(args[1:])
	case "cohort":
		fleetSkillCohort(args[1:])
	case "canary":
		fleetSkillCanary(args[1:])
	case "station":
		fleetSkillStation(args[1:])
	case "native":
		fleetSkillNative(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown fleet skills command: %q\n", args[0])
		os.Exit(2)
	}
}

func fleetSkillNative(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: fleet skills native <plan|inspect|apply|verify> …")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("fleet skills native", flag.ExitOnError)
	station := fs.String("station", "", "station ID")
	profile := fs.String("profile", "", "profile")
	action := fs.String("action", "", "native placement action")
	operation := fs.String("operation", "", "operation ID")
	planDigest := fs.String("plan-digest", "", "reviewed plan digest")
	fs.Parse(args[1:])
	if *station == "" || fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "native commands require --station ID")
		os.Exit(2)
	}
	base := "/api/stations/" + url.PathEscape(*station) + "/skills/native"
	switch args[0] {
	case "plan":
		if *profile == "" || (*action != "activate" && *action != "deactivate" && *action != "rollback") {
			fmt.Fprintln(os.Stderr, "plan requires --profile PROFILE --action activate|deactivate|rollback")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"/plan", map[string]string{"requestId": randomUUID(), "profile": *profile, "action": *action})
	case "inspect":
		if *operation == "" {
			fmt.Fprintln(os.Stderr, "inspect requires --operation ID")
			os.Exit(2)
		}
		fleetGet(base+"/operations/"+url.PathEscape(*operation), nil)
	case "apply":
		if *operation == "" || *planDigest == "" {
			fmt.Fprintln(os.Stderr, "apply requires --operation ID --plan-digest SHA256")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"/operations/"+url.PathEscape(*operation)+"/apply", map[string]string{"planDigest": *planDigest})
	case "verify":
		if *profile == "" {
			fmt.Fprintln(os.Stderr, "verify requires --profile PROFILE")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"/verify", map[string]string{"profile": *profile})
	default:
		fmt.Fprintln(os.Stderr, "usage: fleet skills native <plan|inspect|apply|verify> …")
		os.Exit(2)
	}
}

func fleetSkillStation(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: fleet skills station <verify|rollback-plan|inspect|apply> …")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("fleet skills station", flag.ExitOnError)
	station, profile, operation, planDigest := fs.String("station", "", "station ID"), fs.String("profile", "", "profile"), fs.String("operation", "", "operation ID"), fs.String("plan-digest", "", "reviewed plan digest")
	fs.Parse(args[1:])
	if *station == "" || fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "station commands require --station ID")
		os.Exit(2)
	}
	base := "/api/stations/" + url.PathEscape(*station) + "/skills"
	switch args[0] {
	case "verify":
		if *profile == "" {
			fmt.Fprintln(os.Stderr, "verify requires --profile PROFILE")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"/verify", map[string]string{"profile": *profile})
	case "rollback-plan":
		if *profile == "" {
			fmt.Fprintln(os.Stderr, "rollback-plan requires --profile PROFILE")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"/rollback", map[string]string{"requestId": randomUUID(), "profile": *profile})
	case "inspect":
		if *operation == "" {
			fmt.Fprintln(os.Stderr, "inspect requires --operation ID")
			os.Exit(2)
		}
		fleetGet(base+"/operations/"+url.PathEscape(*operation), nil)
	case "apply":
		if *operation == "" || *planDigest == "" {
			fmt.Fprintln(os.Stderr, "apply requires --operation ID --plan-digest SHA256")
			os.Exit(2)
		}
		fleetSkillJSON(http.MethodPost, base+"/operations/"+url.PathEscape(*operation)+"/apply", map[string]string{"planDigest": *planDigest})
	default:
		fmt.Fprintln(os.Stderr, "usage: fleet skills station <verify|rollback-plan|inspect|apply> …")
		os.Exit(2)
	}
}

func fleetSkillArtifact(args []string) {
	if len(args) == 0 || args[0] != "delete" {
		fmt.Fprintln(os.Stderr, "usage: fleet skills artifact delete --id ARTIFACT_ID")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("fleet skills artifact delete", flag.ExitOnError)
	id := fs.String("id", "", "artifact ID")
	fs.Parse(args[1:])
	if *id == "" || fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: fleet skills artifact delete --id ARTIFACT_ID")
		os.Exit(2)
	}
	fleetSkillRequest(http.MethodDelete, "/api/skills/artifacts/"+url.PathEscape(*id), nil, "")
}

func fleetSkillUpload(args []string) {
	fs := flag.NewFlagSet("fleet skills upload", flag.ExitOnError)
	harness := fs.String("harness", "", "target harness")
	profile := fs.String("profile", "", "skill profile")
	fs.Parse(args)
	if *harness == "" || *profile == "" || fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: fleet skills upload --harness H --profile P ARCHIVE.tgz")
		os.Exit(2)
	}
	f, err := os.Open(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	q := url.Values{"harness": {*harness}, "profile": {*profile}}
	fleetSkillRequest(http.MethodPost, "/api/skills/artifacts?"+q.Encode(), f, "application/gzip")
}

type fleetReleaseRecord struct {
	Profile   string `json:"profile"`
	Artifacts []struct {
		Harness       string `json:"harness"`
		ArchiveSHA256 string `json:"archive_sha256"`
	} `json:"artifacts"`
}
type fleetArtifact struct {
	ID            string `json:"id"`
	Harness       string `json:"harness"`
	Profile       string `json:"profile"`
	ArchiveSHA256 string `json:"archiveSHA256"`
}

func fleetSkillRelease(args []string) {
	if len(args) != 2 || args[0] != "import" {
		fmt.Fprintln(os.Stderr, "usage: fleet skills release import RELEASE.json")
		os.Exit(2)
	}
	recordBytes, err := os.ReadFile(args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var record fleetReleaseRecord
	if err := json.Unmarshal(recordBytes, &record); err != nil || record.Profile == "" || len(record.Artifacts) != 6 {
		fmt.Fprintln(os.Stderr, "release record must be a complete six-harness release JSON")
		os.Exit(2)
	}
	artifactBytes := fleetSkillRequestBytes(http.MethodGet, "/api/skills/artifacts", nil, "")
	var artifacts []fleetArtifact
	if err := json.Unmarshal(artifactBytes, &artifacts); err != nil {
		fmt.Fprintln(os.Stderr, "hub returned invalid artifact metadata")
		os.Exit(1)
	}
	pins := make([]map[string]string, 0, 6)
	for _, wanted := range record.Artifacts {
		found := ""
		for _, candidate := range artifacts {
			if candidate.Harness == wanted.Harness && candidate.Profile == record.Profile && candidate.ArchiveSHA256 == wanted.ArchiveSHA256 {
				found = candidate.ID
				break
			}
		}
		if found == "" {
			fmt.Fprintf(os.Stderr, "missing uploaded artifact for %s (%s)\n", wanted.Harness, wanted.ArchiveSHA256)
			os.Exit(1)
		}
		pins = append(pins, map[string]string{"harness": wanted.Harness, "artifactId": found})
	}
	var raw any
	if err := json.Unmarshal(recordBytes, &raw); err != nil {
		fmt.Fprintln(os.Stderr, "invalid release JSON")
		os.Exit(2)
	}
	fleetSkillJSON(http.MethodPost, "/api/skills/catalog/releases", map[string]any{"record": raw, "artifacts": pins})
}

func fleetSkillCohort(args []string) {
	if len(args) == 0 || args[0] != "create" {
		fmt.Fprintln(os.Stderr, "usage: fleet skills cohort create --release ID --digest SHA256 --station ID")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("fleet skills cohort create", flag.ExitOnError)
	release, digest, station := fs.String("release", "", "release ID"), fs.String("digest", "", "release digest"), fs.String("station", "", "canary station ID")
	fs.Parse(args[1:])
	if *release == "" || *digest == "" || *station == "" || fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: fleet skills cohort create --release ID --digest SHA256 --station ID")
		os.Exit(2)
	}
	fleetSkillJSON(http.MethodPost, "/api/skills/catalog/cohorts", map[string]any{"releaseId": *release, "recordDigest": *digest, "stationIds": []string{*station}})
}

func fleetSkillCanary(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: fleet skills canary <plan|inspect|apply> …")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("fleet skills canary", flag.ExitOnError)
	cohort, release, digest, station, operation, planDigest := fs.String("cohort", "", "cohort ID"), fs.String("release", "", "release ID"), fs.String("digest", "", "release digest"), fs.String("station", "", "station ID"), fs.String("operation", "", "operation ID"), fs.String("plan-digest", "", "reviewed plan digest")
	fs.Parse(args[1:])
	if *cohort == "" || *release == "" || *digest == "" || *station == "" || fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "canary requires --cohort, --release, --digest and --station")
		os.Exit(2)
	}
	base := "/api/skills/catalog/cohorts/" + url.PathEscape(*cohort) + "/canary"
	switch args[0] {
	case "plan":
		fleetSkillJSON(http.MethodPost, base+"/plan", map[string]any{"releaseId": *release, "recordDigest": *digest, "stationId": *station, "requestId": randomHex32()})
	case "inspect", "apply":
		if *operation == "" {
			fmt.Fprintln(os.Stderr, "canary inspect/apply requires --operation")
			os.Exit(2)
		}
		payload := map[string]any{"releaseId": *release, "recordDigest": *digest, "stationId": *station, "operationId": *operation}
		if args[0] == "apply" {
			if *planDigest == "" {
				fmt.Fprintln(os.Stderr, "canary apply requires --plan-digest")
				os.Exit(2)
			}
			payload["planDigest"] = *planDigest
		}
		fleetSkillJSON(http.MethodPost, base+"/operations/"+args[0], payload)
	default:
		fmt.Fprintln(os.Stderr, "usage: fleet skills canary <plan|inspect|apply> …")
		os.Exit(2)
	}
}

func randomHex32() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", bytes)
}

func randomUUID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
}

func fleetSkillJSON(method, path string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	fleetSkillRequest(method, path, bytes.NewReader(b), "application/json")
}
func fleetSkillRequest(method, path string, body io.Reader, contentType string) {
	fmt.Println(string(fleetSkillRequestBytes(method, path, body, contentType)))
}
func fleetSkillRequestBytes(method, path string, body io.Reader, contentType string) []byte {
	c := requireCredential()
	req, err := http.NewRequest(method, hubBase()+path, body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := (&http.Client{Timeout: 75 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not reach %s: %v\n", hubBase(), err)
		os.Exit(1)
	}
	defer res.Body.Close()
	response, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 400 {
		fmt.Fprintf(os.Stderr, "hub returned %d: %s\n", res.StatusCode, bytes.TrimSpace(response))
		os.Exit(1)
	}
	return response
}
