use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::ApiClient;
use crate::types::{Sandbox, SandboxStats};

/// Create sandbox request
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSandboxRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub addons: Option<Vec<String>>,
}

/// Sandbox list response
#[derive(Debug, Deserialize)]
pub struct SandboxListResponse {
    pub sandboxes: Vec<Sandbox>,
}

/// Sandbox stats response
#[derive(Debug, Deserialize)]
pub struct SandboxStatsResponse {
    pub stats: SandboxStats,
}

/// Sandbox logs response
#[derive(Debug, Deserialize)]
pub struct SandboxLogsResponse {
    pub logs: String,
}

impl ApiClient {
    /// List all sandboxes
    pub async fn list_sandboxes(&self) -> Result<Vec<Sandbox>> {
        let response: SandboxListResponse = self.get("/api/v2/sandboxes").await?;
        Ok(response.sandboxes)
    }

    /// Get a sandbox by ID
    pub async fn get_sandbox(&self, id: &str) -> Result<Sandbox> {
        self.get(&format!("/api/v2/sandboxes/{}", id)).await
    }

    /// Get sandbox resource usage statistics
    pub async fn get_sandbox_stats(&self, id: &str) -> Result<SandboxStats> {
        let response: SandboxStatsResponse =
            self.get(&format!("/api/v2/sandboxes/{}/stats", id)).await?;
        Ok(response.stats)
    }

    /// Get sandbox logs
    pub async fn get_sandbox_logs(&self, id: &str, tail: u32) -> Result<String> {
        let response: SandboxLogsResponse = self
            .get(&format!("/api/v2/sandboxes/{}/logs?tail={}", id, tail))
            .await?;
        Ok(response.logs)
    }

    /// Create a new sandbox
    pub async fn create_sandbox(&self, request: CreateSandboxRequest) -> Result<Sandbox> {
        self.post("/api/v2/sandboxes", &request).await
    }

    /// Delete a sandbox
    pub async fn delete_sandbox(&self, id: &str) -> Result<()> {
        self.delete(&format!("/api/v2/sandboxes/{}", id)).await
    }

    /// Start a sandbox
    pub async fn start_sandbox(&self, id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .post(
                &format!("/api/v2/sandboxes/{}/start", id),
                &serde_json::json!({}),
            )
            .await?;
        Ok(())
    }

    /// Stop a sandbox
    pub async fn stop_sandbox(&self, id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .post(
                &format!("/api/v2/sandboxes/{}/stop", id),
                &serde_json::json!({}),
            )
            .await?;
        Ok(())
    }

    /// Restart a sandbox
    pub async fn restart_sandbox(&self, id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .post(
                &format!("/api/v2/sandboxes/{}/restart", id),
                &serde_json::json!({}),
            )
            .await?;
        Ok(())
    }

    /// Pause a sandbox
    pub async fn pause_sandbox(&self, id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .post(
                &format!("/api/v2/sandboxes/{}/pause", id),
                &serde_json::json!({}),
            )
            .await?;
        Ok(())
    }

    /// Unpause a sandbox
    pub async fn unpause_sandbox(&self, id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .post(
                &format!("/api/v2/sandboxes/{}/unpause", id),
                &serde_json::json!({}),
            )
            .await?;
        Ok(())
    }
}
