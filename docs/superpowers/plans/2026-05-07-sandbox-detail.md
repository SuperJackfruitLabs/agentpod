# Sandbox Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sandbox detail view to the Rust TUI with Overview, Stats, and Logs tabs.

**Architecture:** Extend the existing App state machine with `View::SandboxDetail` and a focused `SandboxDetailState`. Keep loading synchronous inside key handlers, matching the current TUI pattern, and use the existing `ApiClient` wrapper for detail, stats, and logs endpoints.

**Tech Stack:** Rust 2021, tokio, ratatui, crossterm, reqwest, serde, wiremock, cargo test.

---

## File Map

- Modify `apps/tui/src/types.rs`: add `SandboxStats` and log response/data types.
- Modify `apps/tui/src/api/sandboxes.rs`: add `get_sandbox_stats` and `get_sandbox_logs` client methods.
- Modify `apps/tui/src/app.rs`: add `View::SandboxDetail`, detail tab/state, Dashboard Enter handling, detail key handling, refresh/load helpers, and status behavior.
- Create `apps/tui/src/ui/views/sandbox_detail.rs`: render the detail layout, tabs, overview, stats, logs, errors, and key hints.
- Modify `apps/tui/src/ui/views/mod.rs`: export the new view module.
- Modify `apps/tui/src/ui/mod.rs`: route `View::SandboxDetail` to the new renderer and keep tab selection on Dashboard.
- Create `apps/tui/tests/sandbox_detail_tests.rs`: app-state and detail API interaction tests.
- Modify `apps/tui/tests/sandbox_tests.rs`: API client tests for stats and logs.

---

### Task 1: Add Stats And Logs API Client Methods

**Files:**
- Modify: `apps/tui/src/types.rs`
- Modify: `apps/tui/src/api/sandboxes.rs`
- Modify: `apps/tui/tests/sandbox_tests.rs`

- [ ] **Step 1: Write failing API tests**

Append these tests to `apps/tui/tests/sandbox_tests.rs`:

```rust
#[tokio::test]
async fn test_get_sandbox_stats_success() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1/stats"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "stats": {
                "cpuPercent": 12.5,
                "memoryUsage": 104857600,
                "memoryLimit": 536870912,
                "memoryPercent": 19.5,
                "networkRx": 2048,
                "networkTx": 4096,
                "blockRead": 8192,
                "blockWrite": 16384
            }
        })))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.get_sandbox_stats("sb-1").await.unwrap();

    assert_eq!(result.cpu_percent, 12.5);
    assert_eq!(result.memory_usage, 104857600);
    assert_eq!(result.memory_limit, 536870912);
    assert_eq!(result.memory_percent, 19.5);
    assert_eq!(result.network_rx, 2048);
    assert_eq!(result.network_tx, 4096);
    assert_eq!(result.block_read, 8192);
    assert_eq!(result.block_write, 16384);
}

#[tokio::test]
async fn test_get_sandbox_logs_success() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1/logs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "logs": "line one\nline two",
            "tail": 100
        })))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.get_sandbox_logs("sb-1", 100).await.unwrap();

    assert_eq!(result, "line one\nline two");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_tests`

Expected: FAIL to compile because `get_sandbox_stats`, `get_sandbox_logs`, and `SandboxStats` do not exist.

- [ ] **Step 3: Add stats/logs types**

In `apps/tui/src/types.rs`, add after `Sandbox`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStats {
    pub cpu_percent: f64,
    pub memory_usage: u64,
    pub memory_limit: u64,
    pub memory_percent: f64,
    pub network_rx: u64,
    pub network_tx: u64,
    pub block_read: u64,
    pub block_write: u64,
}
```

In `apps/tui/src/api/sandboxes.rs`, update the type import:

```rust
use crate::types::{Sandbox, SandboxStats};
```

Add response structs after `SandboxListResponse`:

```rust
#[derive(Debug, Deserialize)]
pub struct SandboxStatsResponse {
    pub stats: SandboxStats,
}

#[derive(Debug, Deserialize)]
pub struct SandboxLogsResponse {
    pub logs: String,
    pub tail: u32,
}
```

- [ ] **Step 4: Add client methods**

In `impl ApiClient` in `apps/tui/src/api/sandboxes.rs`, add after `get_sandbox`:

```rust
    /// Get sandbox resource stats
    pub async fn get_sandbox_stats(&self, id: &str) -> Result<SandboxStats> {
        let response: SandboxStatsResponse = self
            .get(&format!("/api/v2/sandboxes/{}/stats", id))
            .await?;
        Ok(response.stats)
    }

    /// Get recent sandbox logs
    pub async fn get_sandbox_logs(&self, id: &str, tail: u32) -> Result<String> {
        let response: SandboxLogsResponse = self
            .get(&format!("/api/v2/sandboxes/{}/logs?tail={}", id, tail))
            .await?;
        Ok(response.logs)
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_tests`

Expected: PASS with the existing sandbox tests plus the 2 new API tests.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/tui/src/types.rs apps/tui/src/api/sandboxes.rs apps/tui/tests/sandbox_tests.rs
git commit -m "feat(tui): add sandbox detail stats and logs API"
```

---

### Task 2: Add Sandbox Detail State And Dashboard Entry

**Files:**
- Modify: `apps/tui/src/app.rs`
- Create: `apps/tui/tests/sandbox_detail_tests.rs`

- [ ] **Step 1: Write failing state/navigation tests**

Create `apps/tui/tests/sandbox_detail_tests.rs` with:

```rust
use agentpod_tui::app::{App, SandboxDetailTab, View};
use agentpod_tui::cli::Cli;
use agentpod_tui::config::Config;
use agentpod_tui::types::{Sandbox, SandboxStatus};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sandbox(id: &str, name: &str, status: SandboxStatus) -> Sandbox {
    Sandbox {
        id: id.to_string(),
        name: name.to_string(),
        description: Some("from list".to_string()),
        status,
        container_id: Some("container-1".to_string()),
        git_url: Some("https://github.com/acme/repo".to_string()),
        flavor_id: Some("fullstack".to_string()),
        resource_tier_id: Some("builder".to_string()),
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T00:00:00Z".to_string(),
    }
}

fn test_app(api_url: String) -> App {
    let config = Config::default();
    let cli = Cli {
        api_url: Some(api_url),
        token: Some("test-token".to_string()),
        config: None,
        embedded_terminal: false,
        debug: false,
        sandbox: None,
    };
    App::new(config, cli)
}

fn detail_response(id: &str, name: &str) -> serde_json::Value {
    json!({
        "id": id,
        "name": name,
        "description": "fresh detail",
        "status": "running",
        "container_id": "container-fresh",
        "git_url": "https://github.com/acme/repo",
        "flavor_id": "fullstack",
        "resource_tier_id": "builder",
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-02T00:00:00Z"
    })
}

#[tokio::test]
async fn test_dashboard_enter_opens_sandbox_detail_and_loads_fresh_detail() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(detail_response("sb-1", "Fresh Sandbox")))
        .expect(1)
        .mount(&mock_server)
        .await;

    let mut app = test_app(mock_server.uri());
    app.active_view = View::Dashboard;
    app.sandboxes = vec![sandbox("sb-1", "List Sandbox", SandboxStatus::Running)];
    app.selected_sandbox = 0;

    app.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)).await;

    assert_eq!(app.active_view, View::SandboxDetail);
    assert_eq!(app.sandbox_detail.sandbox_id, Some("sb-1".to_string()));
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Overview);
    assert_eq!(app.sandbox_detail.sandbox.as_ref().unwrap().name, "Fresh Sandbox");
    assert!(app.sandbox_detail.error.is_none());
}

#[tokio::test]
async fn test_sandbox_detail_esc_returns_to_dashboard() {
    let mock_server = MockServer::start().await;
    let mut app = test_app(mock_server.uri());
    app.active_view = View::SandboxDetail;
    app.sandbox_detail.sandbox_id = Some("sb-1".to_string());

    app.handle_key_event(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)).await;

    assert_eq!(app.active_view, View::Dashboard);
}

#[tokio::test]
async fn test_dashboard_enter_uses_snapshot_when_detail_load_fails() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "boom"})))
        .expect(1)
        .mount(&mock_server)
        .await;

    let mut app = test_app(mock_server.uri());
    app.active_view = View::Dashboard;
    app.sandboxes = vec![sandbox("sb-1", "List Sandbox", SandboxStatus::Running)];
    app.selected_sandbox = 0;

    app.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)).await;

    assert_eq!(app.active_view, View::SandboxDetail);
    assert_eq!(app.sandbox_detail.sandbox.as_ref().unwrap().name, "List Sandbox");
    assert!(app.sandbox_detail.error.as_ref().unwrap().contains("500"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_detail_tests`

Expected: FAIL to compile because `SandboxDetailTab`, `View::SandboxDetail`, and `App::sandbox_detail` do not exist.

- [ ] **Step 3: Add detail tab/state types**

In `apps/tui/src/app.rs`, add `SandboxStats` to imports:

```rust
use crate::types::{Sandbox, SandboxStats, SandboxStatus};
```

Add `SandboxDetail` to `View`:

```rust
    SandboxDetail,
```

Add after `CreateSandboxWizardState`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxDetailTab {
    Overview,
    Stats,
    Logs,
}

#[derive(Debug, Clone)]
pub struct SandboxDetailState {
    pub sandbox_id: Option<String>,
    pub tab: SandboxDetailTab,
    pub sandbox: Option<Sandbox>,
    pub stats: Option<SandboxStats>,
    pub logs: Option<String>,
    pub error: Option<String>,
    pub loading_detail: bool,
    pub loading_stats: bool,
    pub loading_logs: bool,
}

impl SandboxDetailState {
    fn new() -> Self {
        Self {
            sandbox_id: None,
            tab: SandboxDetailTab::Overview,
            sandbox: None,
            stats: None,
            logs: None,
            error: None,
            loading_detail: false,
            loading_stats: false,
            loading_logs: false,
        }
    }
}
```

Add to `App` fields:

```rust
    pub sandbox_detail: SandboxDetailState,
```

Initialize in `App::new`:

```rust
            sandbox_detail: SandboxDetailState::new(),
```

- [ ] **Step 4: Wire dashboard enter and detail esc**

In `handle_key_event`, update global q guard to exclude detail:

```rust
                if self.active_view != View::Login
                    && self.active_view != View::CreateSandbox
                    && self.active_view != View::SandboxDetail =>
```

Add view route:

```rust
            View::SandboxDetail => self.handle_sandbox_detail_keys(key).await,
```

Replace Dashboard Enter arm:

```rust
            KeyCode::Enter => {
                self.open_selected_sandbox_detail().await;
            }
```

Add methods before `open_create_sandbox`:

```rust
    async fn open_selected_sandbox_detail(&mut self) {
        let Some(snapshot) = self.sandboxes.get(self.selected_sandbox).cloned() else {
            return;
        };
        let sandbox_id = snapshot.id.clone();

        self.sandbox_detail = SandboxDetailState::new();
        self.sandbox_detail.sandbox_id = Some(sandbox_id.clone());
        self.sandbox_detail.sandbox = Some(snapshot);
        self.sandbox_detail.loading_detail = true;
        self.active_view = View::SandboxDetail;

        match self.api.get_sandbox(&sandbox_id).await {
            Ok(sandbox) => {
                self.sandbox_detail.sandbox = Some(sandbox);
                self.sandbox_detail.error = None;
            }
            Err(error) => {
                self.sandbox_detail.error = Some(error.to_string());
            }
        }
        self.sandbox_detail.loading_detail = false;
    }

    async fn handle_sandbox_detail_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.active_view = View::Dashboard;
            }
            _ => {}
        }
    }
```

- [ ] **Step 5: Add temporary UI routing for compile**

In `apps/tui/src/ui/mod.rs`, temporarily route detail to dashboard until Task 4 renderer:

```rust
        crate::app::View::SandboxDetail => views::dashboard::render(frame, app, chunks[1]),
```

Also keep tab selection under Dashboard:

```rust
        crate::app::View::SandboxDetail => 0,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_detail_tests`

Expected: PASS for 3 tests.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/tui/src/app.rs apps/tui/src/ui/mod.rs apps/tui/tests/sandbox_detail_tests.rs
git commit -m "feat(tui): add sandbox detail state"
```

---

### Task 3: Add Detail Tab Navigation And Refresh

**Files:**
- Modify: `apps/tui/src/app.rs`
- Modify: `apps/tui/tests/sandbox_detail_tests.rs`

- [ ] **Step 1: Add failing tab/refresh tests**

Append to `apps/tui/tests/sandbox_detail_tests.rs`:

```rust
#[tokio::test]
async fn test_sandbox_detail_tab_navigation() {
    let mock_server = MockServer::start().await;
    let mut app = test_app(mock_server.uri());
    app.active_view = View::SandboxDetail;
    app.sandbox_detail.sandbox_id = Some("sb-1".to_string());

    app.handle_key_event(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)).await;
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Stats);

    app.handle_key_event(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)).await;
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Logs);

    app.handle_key_event(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)).await;
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Overview);

    app.handle_key_event(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT)).await;
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Logs);
}

#[tokio::test]
async fn test_sandbox_detail_number_keys_jump_tabs() {
    let mock_server = MockServer::start().await;
    let mut app = test_app(mock_server.uri());
    app.active_view = View::SandboxDetail;
    app.sandbox_detail.sandbox_id = Some("sb-1".to_string());

    app.handle_key_event(KeyEvent::new(KeyCode::Char('2'), KeyModifiers::NONE)).await;
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Stats);

    app.handle_key_event(KeyEvent::new(KeyCode::Char('3'), KeyModifiers::NONE)).await;
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Logs);

    app.handle_key_event(KeyEvent::new(KeyCode::Char('1'), KeyModifiers::NONE)).await;
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Overview);
}

#[tokio::test]
async fn test_sandbox_detail_r_refreshes_overview() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(detail_response("sb-1", "Refreshed Sandbox")))
        .expect(1)
        .mount(&mock_server)
        .await;

    let mut app = test_app(mock_server.uri());
    app.active_view = View::SandboxDetail;
    app.sandbox_detail.sandbox_id = Some("sb-1".to_string());
    app.sandbox_detail.sandbox = Some(sandbox("sb-1", "Old Sandbox", SandboxStatus::Running));

    app.handle_key_event(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)).await;

    assert_eq!(app.sandbox_detail.sandbox.as_ref().unwrap().name, "Refreshed Sandbox");
    assert!(app.sandbox_detail.error.is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_detail_tests`

Expected: FAIL because tab switching and refresh are not implemented.

- [ ] **Step 3: Add tab navigation helpers**

In `apps/tui/src/app.rs`, add helpers before `handle_sandbox_detail_keys`:

```rust
    fn sandbox_detail_next_tab(&mut self) {
        self.sandbox_detail.tab = match self.sandbox_detail.tab {
            SandboxDetailTab::Overview => SandboxDetailTab::Stats,
            SandboxDetailTab::Stats => SandboxDetailTab::Logs,
            SandboxDetailTab::Logs => SandboxDetailTab::Overview,
        };
        self.sandbox_detail.error = None;
    }

    fn sandbox_detail_previous_tab(&mut self) {
        self.sandbox_detail.tab = match self.sandbox_detail.tab {
            SandboxDetailTab::Overview => SandboxDetailTab::Logs,
            SandboxDetailTab::Stats => SandboxDetailTab::Overview,
            SandboxDetailTab::Logs => SandboxDetailTab::Stats,
        };
        self.sandbox_detail.error = None;
    }

    async fn refresh_sandbox_detail_overview(&mut self) {
        let Some(sandbox_id) = self.sandbox_detail.sandbox_id.clone() else {
            return;
        };

        self.sandbox_detail.loading_detail = true;
        match self.api.get_sandbox(&sandbox_id).await {
            Ok(sandbox) => {
                self.sandbox_detail.sandbox = Some(sandbox);
                self.sandbox_detail.error = None;
            }
            Err(error) => {
                self.sandbox_detail.error = Some(error.to_string());
            }
        }
        self.sandbox_detail.loading_detail = false;
    }
```

- [ ] **Step 4: Wire detail keys**

Replace `handle_sandbox_detail_keys` with:

```rust
    async fn handle_sandbox_detail_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.active_view = View::Dashboard;
            }
            KeyCode::Tab => self.sandbox_detail_next_tab(),
            KeyCode::BackTab => self.sandbox_detail_previous_tab(),
            KeyCode::Char('1') => self.sandbox_detail.tab = SandboxDetailTab::Overview,
            KeyCode::Char('2') => self.sandbox_detail.tab = SandboxDetailTab::Stats,
            KeyCode::Char('3') => self.sandbox_detail.tab = SandboxDetailTab::Logs,
            KeyCode::Char('r') => match self.sandbox_detail.tab {
                SandboxDetailTab::Overview => self.refresh_sandbox_detail_overview().await,
                SandboxDetailTab::Stats => {}
                SandboxDetailTab::Logs => {}
            },
            _ => {}
        }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_detail_tests`

Expected: PASS with existing and new detail tests.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/tui/src/app.rs apps/tui/tests/sandbox_detail_tests.rs
git commit -m "feat(tui): add sandbox detail navigation"
```

---

### Task 4: Load Stats And Logs Tabs

**Files:**
- Modify: `apps/tui/src/app.rs`
- Modify: `apps/tui/tests/sandbox_detail_tests.rs`

- [ ] **Step 1: Add failing stats/logs refresh tests**

Append to `apps/tui/tests/sandbox_detail_tests.rs`:

```rust
#[tokio::test]
async fn test_sandbox_detail_r_refreshes_stats_tab() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1/stats"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "stats": {
                "cpuPercent": 44.0,
                "memoryUsage": 100,
                "memoryLimit": 200,
                "memoryPercent": 50.0,
                "networkRx": 10,
                "networkTx": 20,
                "blockRead": 30,
                "blockWrite": 40
            }
        })))
        .expect(1)
        .mount(&mock_server)
        .await;

    let mut app = test_app(mock_server.uri());
    app.active_view = View::SandboxDetail;
    app.sandbox_detail.sandbox_id = Some("sb-1".to_string());
    app.sandbox_detail.tab = SandboxDetailTab::Stats;

    app.handle_key_event(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)).await;

    assert_eq!(app.sandbox_detail.stats.as_ref().unwrap().cpu_percent, 44.0);
    assert!(app.sandbox_detail.error.is_none());
}

#[tokio::test]
async fn test_sandbox_detail_r_refreshes_logs_tab() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1/logs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "logs": "booting\nready",
            "tail": 100
        })))
        .expect(1)
        .mount(&mock_server)
        .await;

    let mut app = test_app(mock_server.uri());
    app.active_view = View::SandboxDetail;
    app.sandbox_detail.sandbox_id = Some("sb-1".to_string());
    app.sandbox_detail.tab = SandboxDetailTab::Logs;

    app.handle_key_event(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)).await;

    assert_eq!(app.sandbox_detail.logs.as_deref(), Some("booting\nready"));
    assert!(app.sandbox_detail.error.is_none());
}

#[tokio::test]
async fn test_sandbox_detail_stats_failure_stays_on_stats_with_error() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1/stats"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "stats unavailable"})))
        .expect(1)
        .mount(&mock_server)
        .await;

    let mut app = test_app(mock_server.uri());
    app.active_view = View::SandboxDetail;
    app.sandbox_detail.sandbox_id = Some("sb-1".to_string());
    app.sandbox_detail.tab = SandboxDetailTab::Stats;

    app.handle_key_event(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)).await;

    assert_eq!(app.active_view, View::SandboxDetail);
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Stats);
    assert!(!app.sandbox_detail.loading_stats);
    assert!(app.sandbox_detail.error.as_ref().unwrap().contains("500"));
}

#[tokio::test]
async fn test_sandbox_detail_logs_failure_stays_on_logs_with_error() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1/logs"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "logs unavailable"})))
        .expect(1)
        .mount(&mock_server)
        .await;

    let mut app = test_app(mock_server.uri());
    app.active_view = View::SandboxDetail;
    app.sandbox_detail.sandbox_id = Some("sb-1".to_string());
    app.sandbox_detail.tab = SandboxDetailTab::Logs;

    app.handle_key_event(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)).await;

    assert_eq!(app.active_view, View::SandboxDetail);
    assert_eq!(app.sandbox_detail.tab, SandboxDetailTab::Logs);
    assert!(!app.sandbox_detail.loading_logs);
    assert!(app.sandbox_detail.error.as_ref().unwrap().contains("500"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_detail_tests`

Expected: FAIL because stats/logs refresh handlers are not implemented.

- [ ] **Step 3: Add stats/logs refresh helpers**

In `apps/tui/src/app.rs`, add before `handle_sandbox_detail_keys`:

```rust
    async fn refresh_sandbox_detail_stats(&mut self) {
        let Some(sandbox_id) = self.sandbox_detail.sandbox_id.clone() else {
            return;
        };

        self.sandbox_detail.loading_stats = true;
        match self.api.get_sandbox_stats(&sandbox_id).await {
            Ok(stats) => {
                self.sandbox_detail.stats = Some(stats);
                self.sandbox_detail.error = None;
            }
            Err(error) => {
                self.sandbox_detail.error = Some(error.to_string());
            }
        }
        self.sandbox_detail.loading_stats = false;
    }

    async fn refresh_sandbox_detail_logs(&mut self) {
        let Some(sandbox_id) = self.sandbox_detail.sandbox_id.clone() else {
            return;
        };

        self.sandbox_detail.loading_logs = true;
        match self.api.get_sandbox_logs(&sandbox_id, 100).await {
            Ok(logs) => {
                self.sandbox_detail.logs = Some(logs);
                self.sandbox_detail.error = None;
            }
            Err(error) => {
                self.sandbox_detail.error = Some(error.to_string());
            }
        }
        self.sandbox_detail.loading_logs = false;
    }
```

- [ ] **Step 4: Wire refresh for active tab**

In `handle_sandbox_detail_keys`, replace the `r` match arm with:

```rust
            KeyCode::Char('r') => match self.sandbox_detail.tab {
                SandboxDetailTab::Overview => self.refresh_sandbox_detail_overview().await,
                SandboxDetailTab::Stats => self.refresh_sandbox_detail_stats().await,
                SandboxDetailTab::Logs => self.refresh_sandbox_detail_logs().await,
            },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_detail_tests`

Expected: PASS with all detail tests.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/tui/src/app.rs apps/tui/tests/sandbox_detail_tests.rs
git commit -m "feat(tui): load sandbox detail stats and logs"
```

---

### Task 5: Render Sandbox Detail View

**Files:**
- Create: `apps/tui/src/ui/views/sandbox_detail.rs`
- Modify: `apps/tui/src/ui/views/mod.rs`
- Modify: `apps/tui/src/ui/mod.rs`

- [ ] **Step 1: Add the renderer module**

Create `apps/tui/src/ui/views/sandbox_detail.rs` with:

```rust
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Borders, Paragraph, Tabs, Wrap};
use ratatui::Frame;

use crate::app::{App, SandboxDetailTab};
use crate::util::format_bytes;

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(0), Constraint::Length(2)])
        .split(area);

    render_detail_tabs(frame, app, chunks[0]);
    render_active_tab(frame, app, chunks[1]);
    render_help(frame, chunks[2]);
}

fn render_detail_tabs(frame: &mut Frame, app: &App, area: Rect) {
    let selected = match app.sandbox_detail.tab {
        SandboxDetailTab::Overview => 0,
        SandboxDetailTab::Stats => 1,
        SandboxDetailTab::Logs => 2,
    };

    let title = app
        .sandbox_detail
        .sandbox
        .as_ref()
        .map(|sandbox| format!(" Sandbox: {} [{}] ", sandbox.name, sandbox.status))
        .unwrap_or_else(|| " Sandbox Detail ".to_string());

    let tabs = Tabs::new(vec!["Overview", "Stats", "Logs"])
        .block(Block::default().title(title).borders(Borders::ALL))
        .select(selected)
        .style(Style::default().fg(Color::White))
        .highlight_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD));

    frame.render_widget(tabs, area);
}

fn render_active_tab(frame: &mut Frame, app: &App, area: Rect) {
    let mut lines = match app.sandbox_detail.tab {
        SandboxDetailTab::Overview => overview_lines(app),
        SandboxDetailTab::Stats => stats_lines(app),
        SandboxDetailTab::Logs => logs_lines(app),
    };

    if let Some(error) = &app.sandbox_detail.error {
        lines.push(String::new());
        lines.push(format!("Error: {error}"));
    }

    let title = match app.sandbox_detail.tab {
        SandboxDetailTab::Overview => "Overview",
        SandboxDetailTab::Stats => "Stats",
        SandboxDetailTab::Logs => "Logs",
    };

    frame.render_widget(
        Paragraph::new(lines.join("\n"))
            .block(Block::default().title(title).borders(Borders::ALL))
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn overview_lines(app: &App) -> Vec<String> {
    let Some(sandbox) = &app.sandbox_detail.sandbox else {
        return vec!["No sandbox selected".to_string()];
    };

    vec![
        format!("Name: {}", sandbox.name),
        format!("Status: {}", sandbox.status),
        format!("ID: {}", sandbox.id),
        format!("Description: {}", sandbox.description.as_deref().unwrap_or("-")),
        format!("Git URL: {}", sandbox.git_url.as_deref().unwrap_or("-")),
        format!("Flavor: {}", sandbox.flavor_id.as_deref().unwrap_or("-")),
        format!("Resource tier: {}", sandbox.resource_tier_id.as_deref().unwrap_or("-")),
        format!("Container: {}", sandbox.container_id.as_deref().unwrap_or("-")),
        format!("Created: {}", sandbox.created_at),
        format!("Updated: {}", sandbox.updated_at),
    ]
}

fn stats_lines(app: &App) -> Vec<String> {
    let Some(stats) = &app.sandbox_detail.stats else {
        return vec!["No stats loaded. Press r to refresh.".to_string()];
    };

    vec![
        format!("CPU: {:.1}%", stats.cpu_percent),
        format!(
            "Memory: {} / {} ({:.1}%)",
            format_bytes(stats.memory_usage),
            format_bytes(stats.memory_limit),
            stats.memory_percent
        ),
        format!("Network RX/TX: {} / {}", format_bytes(stats.network_rx), format_bytes(stats.network_tx)),
        format!("Block read/write: {} / {}", format_bytes(stats.block_read), format_bytes(stats.block_write)),
    ]
}

fn logs_lines(app: &App) -> Vec<String> {
    match &app.sandbox_detail.logs {
        Some(logs) if !logs.is_empty() => logs.lines().map(|line| line.to_string()).collect(),
        Some(_) => vec!["No logs available".to_string()],
        None => vec!["No logs loaded. Press r to refresh.".to_string()],
    }
}

fn render_help(frame: &mut Frame, area: Rect) {
    frame.render_widget(
        Paragraph::new(" Tab: next tab | Shift+Tab: previous tab | 1/2/3: jump | r: refresh | Esc: dashboard ")
            .style(Style::default().fg(Color::DarkGray)),
        area,
    );
}
```

- [ ] **Step 2: Export and route the renderer**

In `apps/tui/src/ui/views/mod.rs`, add:

```rust
pub mod sandbox_detail;
```

In `apps/tui/src/ui/mod.rs`, replace temporary detail dashboard route with:

```rust
        crate::app::View::SandboxDetail => views::sandbox_detail::render(frame, app, chunks[1]),
```

Keep tab selection under Dashboard:

```rust
        crate::app::View::SandboxDetail => 0,
```

- [ ] **Step 3: Run compile/tests**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui --test sandbox_detail_tests`

Expected: PASS for detail tests and no compile errors from renderer.

- [ ] **Step 4: Commit**

Run:

```bash
git add apps/tui/src/ui/views/sandbox_detail.rs apps/tui/src/ui/views/mod.rs apps/tui/src/ui/mod.rs
git commit -m "feat(tui): render sandbox detail view"
```

---

### Task 6: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run full TUI tests**

Run: `. "$HOME/.cargo/env" && cargo test -p agentpod-tui`

Expected: all tests pass. Existing scaffold/dead-code/profile warnings may remain.

- [ ] **Step 2: Check git status**

Run: `git status --short --branch`

Expected: clean working tree on `feat/tui`, ahead of `origin/feat/tui` by the new sandbox-detail commits.

- [ ] **Step 3: Report verification evidence**

Report the exact test count from the command output and any remaining warnings or limitations.

---

## Self-Review Notes

- Spec coverage: API methods, dashboard Enter, Overview fallback, Esc, tab switching, active-tab refresh, stats, logs, errors, renderer, and full verification are covered.
- No dynamic background event channel or streaming logs are introduced; this matches the spec's synchronous first-slice constraint.
- No placeholders remain; each task includes concrete tests, implementation code, commands, and commit messages.
- Type names are consistent: `SandboxDetailTab`, `SandboxDetailState`, and `SandboxStats`.
