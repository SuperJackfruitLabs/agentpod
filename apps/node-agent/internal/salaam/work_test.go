package salaam

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkReceiptBinding(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	owner := Status{Binding: b, SessionID: "session", AdmissionID: "admission", BindingDigest: strings.Repeat("a", 64)}
	payload := WorkPayload{Admission: WorkAdmission{Version: 1, RequestID: "11111111-1111-4111-8111-111111111111", Binding: b}, Input: json.RawMessage(`{}`), Plan: json.RawMessage(`{}`)}
	for _, field := range []string{"valid", "session", "digest", "request", "state", "revision"} {
		t.Run(field, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/v1/agentpod/work-admit" {
					t.Error(r.URL.Path)
				}
				receipt := WorkReceipt{Version: 1, State: "admitted", SessionID: owner.SessionID, TaskID: "task", RequestID: payload.Admission.RequestID, BindingDigest: owner.BindingDigest, PlanRevision: 1}
				switch field {
				case "session":
					receipt.SessionID = "other"
				case "digest":
					receipt.BindingDigest = strings.Repeat("b", 64)
				case "request":
					receipt.RequestID = "other"
				case "state":
					receipt.State = "completed"
				case "revision":
					receipt.PlanRevision = 2
				}
				json.NewEncoder(w).Encode(receipt)
			}))
			defer server.Close()
			client := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
			_, err := client.WorkAdmit(context.Background(), payload, owner)
			if (err == nil) != (field == "valid") {
				t.Fatalf("unexpected error: %v", err)
			}
			if calls != 1 {
				t.Fatal(calls)
			}
			bad := payload
			bad.Admission.Binding.Run.Epoch++
			if _, err := client.WorkAdmit(context.Background(), bad, owner); err == nil {
				t.Fatal("accepted changed lease")
			}
			if calls != 1 {
				t.Fatal("invalid lease reached transport")
			}
		})
	}
}

type roundTripWork struct{ url string }

func (r roundTripWork) RoundTrip(req *http.Request) (*http.Response, error) {
	copy := req.Clone(req.Context())
	u := *req.URL
	copy.URL = &u
	target, _ := http.NewRequest("GET", r.url, nil)
	copy.URL.Scheme = target.URL.Scheme
	copy.URL.Host = target.URL.Host
	return http.DefaultTransport.RoundTrip(copy)
}

func TestWorkDecisionControlIsClosed(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	owner := Status{Binding: b, SessionID: "session"}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/agentpod/work-evidence" && r.URL.Path != "/v1/agentpod/work-decisions" && r.URL.Path != "/v1/agentpod/work-decision" && r.URL.Path != "/v1/agentpod/work-completion" {
			t.Fatal(r.URL.Path)
		}
		if r.URL.Path == "/v1/agentpod/work-evidence" {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["schema_version"] != "salaam-execution-evidence/v1" {
				t.Fatal("missing explicit evidence version")
			}
		}
		w.Write([]byte(`{"version":1}`))
	}))
	defer server.Close()
	client := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	for _, action := range []string{"work-evidence", "work-decisions", "work-decision", "work-completion"} {
		var answer json.RawMessage
		if action == "work-decision" {
			answer = json.RawMessage(`{"version":1}`)
		}
		if _, err := client.WorkControl(context.Background(), action, b, answer, owner); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 4 {
		t.Fatal(calls)
	}
	for _, action := range []string{"renew", "work-admit", "approve-all"} {
		if _, err := client.WorkControl(context.Background(), action, b, nil, owner); err == nil {
			t.Fatal("accepted foreign action")
		}
	}
	if _, err := client.WorkControl(context.Background(), "work-decisions", b, json.RawMessage(`{}`), owner); err == nil {
		t.Fatal("accepted discovery grant")
	}
	changed := owner
	changed.Binding.Run.Epoch++
	if _, err := client.WorkControl(context.Background(), "work-decisions", b, nil, changed); err == nil {
		t.Fatal("accepted stale owner")
	}
	if calls != 4 {
		t.Fatal("invalid controls reached daemon")
	}
}

func TestBoundedProgressionNeverForwardsChangedOwnerOrGrant(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_fixture", Epoch: 1}}
	owner := Status{Binding: b, SessionID: "session"}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/agentpod/work-progress" {
			t.Error(r.URL.Path)
		}
		w.Write([]byte(`{"version":1}`))
	}))
	defer server.Close()
	client := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	original := WorkProgress{Binding: b, RequestID: "11111111-1111-4111-8111-111111111111", WorkRequestID: "11111111-1111-4111-8111-111111111111", MaxSteps: 1}
	if _, err := client.ProgressWork(context.Background(), original, owner); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*WorkProgress){func(p *WorkProgress) { p.MaxSteps = 0 }, func(p *WorkProgress) { p.MaxSteps = 33 }, func(p *WorkProgress) { p.Compact = true }, func(p *WorkProgress) { p.RequestID = "22222222-2222-4222-8222-222222222222" }, func(p *WorkProgress) { p.Binding.Run.Epoch++ }} {
		p := original
		change(&p)
		if _, err := client.ProgressWork(context.Background(), p, owner); err == nil {
			t.Fatal("invalid progression reached transport")
		}
	}
	if calls != 1 {
		t.Fatal("invalid grant was forwarded")
	}
}

func TestTerminalSettlementRequiresExactStoppedOwner(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	p := WorkSettlement{Binding: b, RequestID: "11111111-1111-4111-8111-111111111111", WorkRequestID: "22222222-2222-4222-8222-222222222222", ProducerTerminalDigest: strings.Repeat("a", 64)}
	owner := Status{Binding: b, BindingDigest: canonicalDigest(b), SessionID: "session", Revoked: true, OwnedExecutionStopped: true}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/agentpod/work-settle" {
			t.Error(r.URL.Path)
		}
		w.Write([]byte(`{"state":"cancelled"}`))
	}))
	defer server.Close()
	c := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	if _, err := c.SettleWork(context.Background(), p, owner); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Status{{Binding: b, SessionID: "session"}, {Binding: b, SessionID: "session", Revoked: true, OwnedExecutionStopped: true, Authorized: true}, {Binding: b, SessionID: "session", Revoked: true, OwnedExecutionStopped: true, UnresolvedOperations: []string{"uncertain"}}} {
		if _, err := c.SettleWork(context.Background(), p, bad); err == nil {
			t.Fatal("accepted unstopped owner")
		}
	}
	if calls != 1 {
		t.Fatal("refused request reached daemon")
	}
}

func TestExpiredApprovalRequiresExactStoppedOwner(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	p := WorkExpiry{WorkSettlement: WorkSettlement{Binding: b, RequestID: "11111111-1111-4111-8111-111111111111", WorkRequestID: "22222222-2222-4222-8222-222222222222", ProducerTerminalDigest: strings.Repeat("a", 64)}, DecisionRequestID: "33333333-3333-4333-8333-333333333333"}
	owner := Status{Binding: b, BindingDigest: canonicalDigest(b), SessionID: "session", Revoked: true, OwnedExecutionStopped: true}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/agentpod/work-expire" {
			t.Error(r.URL.Path)
		}
		w.Write([]byte(`{"state":"cancelled"}`))
	}))
	defer server.Close()
	c := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	if _, err := c.ExpireWork(context.Background(), p, owner); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Status{{Binding: b, SessionID: "session"}, {Binding: b, SessionID: "session", Revoked: true, OwnedExecutionStopped: true, Authorized: true}, {Binding: b, SessionID: "session", Revoked: true, OwnedExecutionStopped: true, UnresolvedOperations: []string{"uncertain"}}} {
		if _, err := c.ExpireWork(context.Background(), p, bad); err == nil {
			t.Fatal("accepted unstopped owner")
		}
	}
	if calls != 1 {
		t.Fatal("refused request reached daemon")
	}
}

func TestKnownEffectFailureRequiresStoppedOwnerAndPreservesInterruptedHistory(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	p := WorkSettlement{Binding: b, RequestID: "11111111-1111-4111-8111-111111111111", WorkRequestID: "22222222-2222-4222-8222-222222222222", ProducerTerminalDigest: strings.Repeat("a", 64)}
	owner := Status{Binding: b, BindingDigest: canonicalDigest(b), SessionID: "session", Revoked: true, OwnedExecutionStopped: true, InterruptedAttempts: []string{"historical-interrupted"}}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/agentpod/work-fail" {
			t.Error(r.URL.Path)
		}
		w.Write([]byte(`{"state":"cancelled"}`))
	}))
	defer server.Close()
	c := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	if _, err := c.FailWork(context.Background(), p, owner); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Status{{Binding: b, SessionID: "session"}, {Binding: b, SessionID: "session", Revoked: true, OwnedExecutionStopped: true, Authorized: true}, {Binding: b, SessionID: "session", Revoked: true, OwnedExecutionStopped: true, UnresolvedOperations: []string{"uncertain"}}} {
		if _, err := c.FailWork(context.Background(), p, bad); err == nil {
			t.Fatal("accepted unstopped owner")
		}
	}
	if calls != 1 {
		t.Fatal("refused request reached daemon")
	}
}

func TestAbandonLocalSuccessRequiresStoppedOwnerAndNoInterruptedAttempts(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	p := WorkSettlement{Binding: b, RequestID: "11111111-1111-4111-8111-111111111111", WorkRequestID: "22222222-2222-4222-8222-222222222222", ProducerTerminalDigest: strings.Repeat("a", 64)}
	owner := Status{Binding: b, BindingDigest: canonicalDigest(b), SessionID: "session", Revoked: true, OwnedExecutionStopped: true, InterruptedAttempts: []string{}}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/agentpod/work-abandon" {
			t.Error(r.URL.Path)
		}
		w.Write([]byte(`{"state":"cancelled"}`))
	}))
	defer server.Close()
	c := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	if _, err := c.AbandonWork(context.Background(), p, owner); err != nil {
		t.Fatal(err)
	}
	badInterrupted := owner
	badInterrupted.InterruptedAttempts = []string{"interrupted"}
	for _, bad := range []Status{badInterrupted, {Binding: b, SessionID: "session"}, {Binding: b, SessionID: "session", Revoked: true, OwnedExecutionStopped: true, Authorized: true}, {Binding: b, SessionID: "session", Revoked: true, OwnedExecutionStopped: true, UnresolvedOperations: []string{"uncertain"}}} {
		if _, err := c.AbandonWork(context.Background(), p, bad); err == nil {
			t.Fatal("accepted unstopped owner")
		}
	}
	if calls != 1 {
		t.Fatal("refused request reached daemon")
	}
}

func TestWorkTraceIsClosedCorrelationOnly(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/agentpod/work-trace" {
			t.Fatal(r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 3 || body["schema_version"] != "salaam-work-trace/v1" {
			t.Fatal("trace envelope changed authority")
		}
		w.Write([]byte(`{"version":1,"authority":false,"traceparent":"00-11111111111111111111111111111111-2222222222222222-01"}`))
	}))
	defer server.Close()
	client := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	if _, err := client.WorkTrace(context.Background(), b, "00-11111111111111111111111111111111-2222222222222222-01"); err != nil {
		t.Fatal(err)
	}
	for _, parent := range []string{"", "00-00000000000000000000000000000000-2222222222222222-01", "00-11111111111111111111111111111111-0000000000000000-01", "bad"} {
		if _, err := client.WorkTrace(context.Background(), b, parent); err == nil {
			t.Fatal("invalid trace accepted")
		}
	}
	if calls != 1 {
		t.Fatal("invalid trace reached daemon")
	}
}

func TestEvidenceArtifactTransportBoundIsExplicitAndControlRemainsSmall(t *testing.T) {
	b := Binding{Version: 1, OrganizationID: "org_00000000000000000000", PrincipalID: "prn_00000000000000000000", NodeID: "node", StationID: "station", StationKey: StationKey("/work"), Workspace: "/work", OccupancyEpoch: 1, HubSessionID: "hub", Run: Run{Source: "superpipeline", ID: "run_abcdef", Epoch: 1}}
	id := "33333333-3333-4333-8333-333333333333"
	calls := 0
	size := 2 << 20
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		json.NewEncoder(w).Encode(map[string]string{"content_base64": strings.Repeat("a", size)})
	}))
	defer server.Close()
	client := Client{NodeID: "node", Workspace: "/work", HTTP: &http.Client{Transport: roundTripWork{server.URL}}}
	if _, err := client.WorkEvidenceArtifacts(context.Background(), b, []string{id}); err != nil {
		t.Fatal(err)
	}
	for _, ids := range [][]string{nil, {id, id}, {"artifact_foreign"}} {
		if _, err := client.WorkEvidenceArtifacts(context.Background(), b, ids); err == nil {
			t.Fatal("bad selection accepted")
		}
	}
	if calls != 1 {
		t.Fatal("invalid selections reached source")
	}
	if _, err := client.WorkTrace(context.Background(), b, "00-11111111111111111111111111111111-2222222222222222-01"); err == nil {
		t.Fatal("legacy control limit widened")
	}
	size = 9 << 20
	if _, err := client.WorkEvidenceArtifacts(context.Background(), b, []string{id}); err == nil {
		t.Fatal("oversized evidence accepted")
	}
}
