use agentpod_tui::api::{sandboxes::CreateSandboxRequest, ApiClient};
use agentpod_tui::types::SandboxStatus;
use serde_json::json;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn test_list_sandboxes_success() {
    let mock_server = MockServer::start().await;

    let sandboxes = json!({
        "sandboxes": [
            {
                "id": "sb-1",
                "name": "Test Sandbox 1",
                "description": "A test sandbox",
                "status": "running",
                "container_id": "container-1",
                "git_url": null,
                "flavor_id": "fullstack",
                "resource_tier_id": "builder",
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z"
            },
            {
                "id": "sb-2",
                "name": "Test Sandbox 2",
                "description": null,
                "status": "stopped",
                "container_id": null,
                "git_url": "https://github.com/test/repo",
                "flavor_id": "python",
                "resource_tier_id": "starter",
                "created_at": "2024-01-02T00:00:00Z",
                "updated_at": "2024-01-02T00:00:00Z"
            }
        ]
    });

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(sandboxes))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.list_sandboxes().await.unwrap();

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].id, "sb-1");
    assert_eq!(result[0].name, "Test Sandbox 1");
    assert_eq!(result[0].status, SandboxStatus::Running);
    assert_eq!(result[1].id, "sb-2");
    assert_eq!(result[1].name, "Test Sandbox 2");
    assert_eq!(result[1].status, SandboxStatus::Stopped);
}

#[tokio::test]
async fn test_list_sandboxes_empty() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"sandboxes": []})))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.list_sandboxes().await.unwrap();

    assert_eq!(result.len(), 0);
}

#[tokio::test]
async fn test_list_sandboxes_unauthorized() {
    let mock_server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "Unauthorized"})))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("bad-token".to_string()));
    let result = client.list_sandboxes().await;

    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("401"));
}

#[tokio::test]
async fn test_get_sandbox_success() {
    let mock_server = MockServer::start().await;

    let sandbox = json!({
        "id": "sb-1",
        "name": "Test Sandbox",
        "description": "A test sandbox",
        "status": "running",
        "container_id": "container-1",
        "git_url": null,
        "flavor_id": "fullstack",
        "resource_tier_id": "builder",
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z"
    });

    Mock::given(method("GET"))
        .and(path("/api/v2/sandboxes/sb-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(sandbox))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.get_sandbox("sb-1").await.unwrap();

    assert_eq!(result.id, "sb-1");
    assert_eq!(result.name, "Test Sandbox");
    assert_eq!(result.status, SandboxStatus::Running);
}

#[tokio::test]
async fn test_start_sandbox_success() {
    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/v2/sandboxes/sb-1/start"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true})))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.start_sandbox("sb-1").await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_stop_sandbox_success() {
    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/v2/sandboxes/sb-1/stop"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true})))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.stop_sandbox("sb-1").await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_delete_sandbox_success() {
    let mock_server = MockServer::start().await;

    Mock::given(method("DELETE"))
        .and(path("/api/v2/sandboxes/sb-1"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.delete_sandbox("sb-1").await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_create_sandbox_sends_api_field_names() {
    let mock_server = MockServer::start().await;

    let expected_body = json!({
        "name": "New Sandbox",
        "description": "Created from the TUI",
        "githubUrl": "https://github.com/test/repo",
        "flavor": "fullstack",
        "resourceTier": "builder",
        "addons": ["code-server"]
    });

    let response_body = json!({
        "id": "sb-new",
        "name": "New Sandbox",
        "description": "Created from the TUI",
        "status": "creating",
        "container_id": null,
        "git_url": "https://github.com/test/repo",
        "flavor_id": "fullstack",
        "resource_tier_id": "builder",
        "created_at": "2024-01-03T00:00:00Z",
        "updated_at": "2024-01-03T00:00:00Z"
    });

    Mock::given(method("POST"))
        .and(path("/api/v2/sandboxes"))
        .and(body_json(expected_body))
        .respond_with(ResponseTemplate::new(200).set_body_json(response_body))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client
        .create_sandbox(CreateSandboxRequest {
            name: "New Sandbox".to_string(),
            description: Some("Created from the TUI".to_string()),
            github_url: Some("https://github.com/test/repo".to_string()),
            flavor: Some("fullstack".to_string()),
            resource_tier: Some("builder".to_string()),
            addons: Some(vec!["code-server".to_string()]),
        })
        .await
        .unwrap();

    assert_eq!(result.id, "sb-new");
    assert_eq!(result.status, SandboxStatus::Creating);
}

#[tokio::test]
async fn test_restart_sandbox_success() {
    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/v2/sandboxes/sb-1/restart"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true})))
        .mount(&mock_server)
        .await;

    let client = ApiClient::new(&mock_server.uri(), Some("test-token".to_string()));
    let result = client.restart_sandbox("sb-1").await;

    assert!(result.is_ok());
}

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
