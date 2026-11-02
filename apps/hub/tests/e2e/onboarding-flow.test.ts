/**
 * E2E Tests for Onboarding Flow
 *
 * Tests the complete onboarding system flow:
 * 1. API creates sandbox → injects onboarding env vars
 * 2. Container starts → installs agents, configures MCP
 * 3. Container calls MCP endpoint on Management API
 * 4. MCP tools return knowledge documents correctly
 *
 * These tests use REAL Docker containers and require:
 * - Docker to be running
 * - agentpod-fullstack:latest image available
 * - Management API running on localhost:3001
 * - PostgreSQL with seeded knowledge base
 *
 * Run with: bun test tests/e2e/onboarding-flow.test.ts
 * Or with custom token: API_TOKEN=your-token bun test tests/e2e/onboarding-flow.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { E2EDockerClient } from "./helpers/docker";
import {
  getE2EDockerClient,
  canRunE2ETests,
  httpFromContainer,
} from "./helpers/docker";

// =============================================================================
// Test Configuration
// =============================================================================

const TEST_IMAGE = "agentpod-fullstack:latest";
const MANAGEMENT_API_URL = "http://host.docker.internal:3001";

/**
 * Get API token from environment or .env file
 * Priority: process.env.API_TOKEN > .env file > default
 */
function getApiToken(): string {
  // First check environment variable
  if (process.env.API_TOKEN && process.env.API_TOKEN !== "test-token") {
    return process.env.API_TOKEN;
  }

  // Try to read from .env file (for E2E tests hitting real API)
  const envPath = join(__dirname, "../../.env");
  if (existsSync(envPath)) {
    try {
      const envContent = readFileSync(envPath, "utf-8");
      const match = envContent.match(/^API_TOKEN=(.+)$/m);
      if (match && match[1]) {
        return match[1].replace(/["']/g, "").trim();
      }
    } catch {
      // Ignore read errors
    }
  }

  // Fall back to default
  return "dev-token-change-in-production";
}

const TEST_AUTH_TOKEN = getApiToken();
const TEST_TIMEOUT = 180000; // 3 minutes for each test

// =============================================================================
// Test Setup
// =============================================================================

describe.skip("Onboarding E2E Flow", () => {
  let dockerClient: E2EDockerClient;
  let canRun: boolean;
  let skipReason: string | undefined;

  beforeAll(async () => {
    dockerClient = getE2EDockerClient();

    // Check if E2E tests can run
    const check = await canRunE2ETests(TEST_IMAGE);
    canRun = check.canRun;
    skipReason = check.reason;

    if (!canRun) {
      console.warn(`E2E tests will be skipped: ${skipReason}`);
    }
  });

  afterAll(async () => {
    // Cleanup all E2E containers
    if (dockerClient) {
      await dockerClient.cleanup();
    }
  });

  // ===========================================================================
  // Prerequisites Check
  // ===========================================================================

  describe("Prerequisites", () => {
    test("Docker is available", async () => {
      const available = await dockerClient.isDockerAvailable();
      expect(available).toBe(true);
    });

    test("Test image exists", async () => {
      const exists = await dockerClient.imageExists(TEST_IMAGE);
      if (!exists) {
        console.warn(`Image ${TEST_IMAGE} not found. Build with: cd docker && ./scripts/build.sh`);
      }
      expect(exists).toBe(true);
    });
  });

  // ===========================================================================
  // Container Startup & Agent Installation
  // ===========================================================================

  describe("Container Startup with Onboarding", () => {
    test(
      "should start container with onboarding environment variables",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const sessionId = `e2e-session-${Date.now()}`;

        const container = await dockerClient.createContainer({
          name: `onboarding-env-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: sessionId,
          },
          // No ports needed - we use docker exec for all commands
          waitForHealth: false,
        });

        expect(container.id).toBeDefined();
        expect(container.status).toBe("running");

        // Wait for entrypoint to complete
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Check environment variables are set
        const envResult = await dockerClient.exec(container.id, [
          "sh",
          "-c",
          "echo $ONBOARDING_MODE $ONBOARDING_SESSION_ID",
        ]);

        expect(envResult.exitCode).toBe(0);
        expect(envResult.stdout).toContain("true");
        expect(envResult.stdout).toContain(sessionId);
      },
      TEST_TIMEOUT
    );

    test(
      "should install onboarding agents in container",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const container = await dockerClient.createContainer({
          name: `onboarding-agents-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: `e2e-session-${Date.now()}`,
          },
          waitForHealth: false,
        });

        // Wait for entrypoint to set up agents
        await new Promise((resolve) => setTimeout(resolve, 15000));

        // Check if onboarding agent was installed
        const agentCheck = await dockerClient.exec(container.id, [
          "ls",
          "-la",
          "/home/workspace/.opencode/agent/",
        ]);

        expect(agentCheck.exitCode).toBe(0);
        expect(agentCheck.stdout).toContain("onboarding.md");
        expect(agentCheck.stdout).toContain("workspace.md");
      },
      TEST_TIMEOUT
    );

    test(
      "should configure opencode.json with MCP endpoint",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const container = await dockerClient.createContainer({
          name: `onboarding-config-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: `e2e-session-${Date.now()}`,
          },
          waitForHealth: false,
        });

        // Wait for entrypoint
        await new Promise((resolve) => setTimeout(resolve, 15000));

        // Check opencode.json exists and has MCP config
        const configCheck = await dockerClient.exec(container.id, [
          "cat",
          "/home/workspace/opencode.json",
        ]);

        expect(configCheck.exitCode).toBe(0);

        // Parse and verify MCP configuration
        const config = JSON.parse(configCheck.stdout);
        expect(config).toHaveProperty("mcp");
        expect(config.mcp).toHaveProperty("agentpod_knowledge");

        const knowledgeServer = config.mcp["agentpod_knowledge"];
        expect(knowledgeServer.type).toBe("remote");
        expect(knowledgeServer.url).toContain("/api/mcp/knowledge");
      },
      TEST_TIMEOUT
    );
  });

  // ===========================================================================
  // MCP Communication from Container
  // ===========================================================================

  describe("MCP Communication", () => {
    test(
      "should successfully call MCP tools/list from inside container",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const container = await dockerClient.createContainer({
          name: `mcp-list-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: `e2e-session-${Date.now()}`,
          },
          waitForHealth: false,
        });

        // Wait for container to be ready
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Call MCP tools/list endpoint from inside container
        const response = await httpFromContainer(
          dockerClient,
          container.id,
          "POST",
          `${MANAGEMENT_API_URL}/api/mcp/knowledge`,
          { method: "tools/list" },
          {
            "Authorization": `Bearer ${TEST_AUTH_TOKEN}`,
            "Content-Type": "application/json",
          }
        );

        expect(response.status).toBe(200);

        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("tools");
        expect(Array.isArray(data.tools)).toBe(true);

        // Verify expected tools are present
        const toolNames = data.tools.map((t: { name: string }) => t.name);
        expect(toolNames).toContain("search_knowledge");
        expect(toolNames).toContain("get_project_template");
        expect(toolNames).toContain("get_agent_pattern");
        expect(toolNames).toContain("get_command_template");
        expect(toolNames).toContain("list_project_types");
        expect(toolNames).toContain("get_available_models");
        expect(toolNames).toContain("get_provider_setup_guide");
      },
      TEST_TIMEOUT
    );

    test(
      "should call search_knowledge tool from inside container",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const container = await dockerClient.createContainer({
          name: `mcp-search-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: `e2e-session-${Date.now()}`,
          },
          waitForHealth: false,
        });

        // Wait for container to be ready
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Call search_knowledge tool
        const response = await httpFromContainer(
          dockerClient,
          container.id,
          "POST",
          `${MANAGEMENT_API_URL}/api/mcp/knowledge`,
          {
            method: "tools/call",
            params: {
              name: "search_knowledge",
              arguments: {
                query: "web application setup",
                limit: 5,
              },
            },
          },
          {
            "Authorization": `Bearer ${TEST_AUTH_TOKEN}`,
            "Content-Type": "application/json",
          }
        );

        expect(response.status).toBe(200);

        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("content");
        expect(Array.isArray(data.content)).toBe(true);
        expect(data.content.length).toBeGreaterThan(0);

        // First content item should be text with results
        const textContent = data.content[0];
        expect(textContent.type).toBe("text");
        expect(textContent.text).toBeDefined();
      },
      TEST_TIMEOUT
    );

    test(
      "should call list_project_types tool from inside container",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const container = await dockerClient.createContainer({
          name: `mcp-projects-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: `e2e-session-${Date.now()}`,
          },
          waitForHealth: false,
        });

        // Wait for container
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Call list_project_types
        const response = await httpFromContainer(
          dockerClient,
          container.id,
          "POST",
          `${MANAGEMENT_API_URL}/api/mcp/knowledge`,
          {
            method: "tools/call",
            params: {
              name: "list_project_types",
              arguments: {},
            },
          },
          {
            "Authorization": `Bearer ${TEST_AUTH_TOKEN}`,
            "Content-Type": "application/json",
          }
        );

        expect(response.status).toBe(200);

        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("content");
        expect(data.content[0].type).toBe("text");

        // Parse the project types
        const projectTypesText = data.content[0].text;
        expect(projectTypesText).toContain("web_app");
      },
      TEST_TIMEOUT
    );

    test(
      "should call get_available_models tool from inside container",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const container = await dockerClient.createContainer({
          name: `mcp-models-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: `e2e-session-${Date.now()}`,
          },
          waitForHealth: false,
        });

        // Wait for container
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Call get_available_models
        const response = await httpFromContainer(
          dockerClient,
          container.id,
          "POST",
          `${MANAGEMENT_API_URL}/api/mcp/knowledge`,
          {
            method: "tools/call",
            params: {
              name: "get_available_models",
              arguments: {},
            },
          },
          {
            "Authorization": `Bearer ${TEST_AUTH_TOKEN}`,
            "Content-Type": "application/json",
          }
        );

        expect(response.status).toBe(200);

        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("content");
        expect(data.content[0].type).toBe("text");

        // Should contain provider information
        const modelsText = data.content[0].text;
        expect(modelsText.toLowerCase()).toMatch(/provider|model|anthropic|openai/i);
      },
      TEST_TIMEOUT
    );
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe("Error Handling", () => {
    test(
      "should handle authentication errors from container",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const container = await dockerClient.createContainer({
          name: `mcp-auth-error-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: `e2e-session-${Date.now()}`,
          },
          waitForHealth: false,
        });

        // Wait for container
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Call without auth header
        const response = await httpFromContainer(
          dockerClient,
          container.id,
          "POST",
          `${MANAGEMENT_API_URL}/api/mcp/knowledge`,
          { method: "tools/list" },
          {
            "Content-Type": "application/json",
            // No X-API-Key header
          }
        );

        expect(response.status).toBe(401);
      },
      TEST_TIMEOUT
    );

    test(
      "should handle invalid tool calls gracefully",
      async () => {
        if (!canRun) {
          console.warn(`Skipping: ${skipReason}`);
          return;
        }

        const container = await dockerClient.createContainer({
          name: `mcp-invalid-tool-test`,
          image: TEST_IMAGE,
          env: {
            MANAGEMENT_API_URL,
            ONBOARDING_MODE: "true",
            ONBOARDING_SESSION_ID: `e2e-session-${Date.now()}`,
          },
          waitForHealth: false,
        });

        // Wait for container
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Call non-existent tool
        const response = await httpFromContainer(
          dockerClient,
          container.id,
          "POST",
          `${MANAGEMENT_API_URL}/api/mcp/knowledge`,
          {
            method: "tools/call",
            params: {
              name: "non_existent_tool",
              arguments: {},
            },
          },
          {
            "Authorization": `Bearer ${TEST_AUTH_TOKEN}`,
            "Content-Type": "application/json",
          }
        );

        expect(response.status).toBe(200); // MCP returns 200 with error in content

        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("isError", true);
        expect(data).toHaveProperty("content");
        expect(data.content[0].text).toContain("Unknown tool");
      },
      TEST_TIMEOUT
    );
  });

  // ===========================================================================
  // Cleanup Tests (run last)
  // ===========================================================================

  describe("Cleanup", () => {
    test(
      "should list and cleanup all E2E containers",
      async () => {
        const containers = await dockerClient.listE2EContainers();
        console.log(`Found ${containers.length} E2E containers to cleanup`);

        // Small delay to allow any in-progress operations to complete
        await new Promise((resolve) => setTimeout(resolve, 2000));

        await dockerClient.cleanup();

        // Wait for cleanup to propagate
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify cleanup completed
        const remainingContainers = await dockerClient.listE2EContainers();
        console.log(`${remainingContainers.length} containers remain (will be cleaned in afterAll)`);
      },
      30000 // 30 second timeout for cleanup
    );
  });
});
