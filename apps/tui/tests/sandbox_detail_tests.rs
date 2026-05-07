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
