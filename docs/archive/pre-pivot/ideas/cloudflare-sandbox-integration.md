# Cloudflare Sandbox SDK Integration

> **Status:** ✅ Implemented  
> **Created:** December 2024  
> **Implemented:** December 2025  
> **Author:** Architecture Session  
> **Branch:** `feature/cloudflare-sandbox-integration`

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| Cloudflare Worker | ✅ Deployed | `cloudflare/worker/` |
| R2 Storage Utility | ✅ Complete | `cloudflare/worker/src/storage.ts` |
| API Provider | ✅ Complete | `apps/api/src/services/providers/cloudflare-provider.ts` |
| Webhook Handler | ✅ Complete | `apps/api/src/routes/cloudflare-webhook.ts` |
| Database Schema | ✅ Migrated | `apps/api/src/db/schema/cloudflare.ts` |
| Agent Routes | ✅ Complete | `apps/api/src/routes/agents.ts` |
| Provider Factory | ✅ Complete | `apps/api/src/services/providers/index.ts` |
| Frontend Integration | 🔄 Pending | - |

**Live Worker URL:** `https://agentpod-sandbox.mail-88a.workers.dev`

---  

## Overview

This document outlines the integration of [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk) into AgentPod to enable lightweight, on-demand AI agent execution alongside the existing Docker-based sandbox system.

## Motivation

### Current Challenges with Docker-Only Architecture

| Challenge | Impact |
|-----------|--------|
| **Resource overhead** | Full OS container per sandbox (~500MB+ RAM) |
| **Cold start latency** | 5-15 seconds to start a container |
| **Cost at scale** | Fixed infrastructure cost regardless of usage |
| **Idle resources** | Containers run even when not actively used |

### Cloudflare Sandbox Benefits

| Benefit | Description |
|---------|-------------|
| **Lightweight execution** | VM-based isolation, minimal overhead |
| **Wake-on-demand** | Sandboxes hibernate after 10 minutes of inactivity |
| **Pay-per-request** | Only charged when sandbox is active |
| **Higher concurrency** | Run more agent instances simultaneously |
| **Edge deployment** | Lower latency, global distribution |

### Key Discovery

**Cloudflare SDK has first-class OpenCode support** via:
- `createOpencodeServer()` - Starts OpenCode server inside sandbox
- `proxyToOpencode()` - Proxies web UI requests  
- `createOpencode()` - Returns typed `@opencode-ai/sdk` client

Both AgentPod and Cloudflare use the **same `@opencode-ai/sdk` client**, making integration seamless.

---

## Proposed Hybrid Architecture

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AgentPod Management API                          │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    SandboxProvider Interface                     │   │
│  │                                                                   │   │
│  │   createSandbox(options)                                         │   │
│  │   startSandbox(id)                                               │   │
│  │   stopSandbox(id)                                                │   │
│  │   getOpenCodeClient(id) → @opencode-ai/sdk client               │   │
│  │   proxyRequest(id, request) → Response                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│               │                                   │                     │
│               ▼                                   ▼                     │
│  ┌─────────────────────────┐       ┌─────────────────────────────┐    │
│  │   DockerSandboxProvider │       │  CloudflareSandboxProvider  │    │
│  │   (existing code)       │       │  (NEW - Cloudflare Workers) │    │
│  │                         │       │                             │    │
│  │   - Full OS container   │       │  - Lightweight VM           │    │
│  │   - Persistent state    │       │  - R2-based persistence     │    │
│  │   - Dev environments    │       │  - Dynamic agent tasks      │    │
│  │   - Code editing        │       │  - Wake-on-demand           │    │
│  └───────────┬─────────────┘       └───────────────┬─────────────┘    │
│              │                                     │                   │
└──────────────┼─────────────────────────────────────┼───────────────────┘
               │                                     │
               ▼                                     ▼
┌──────────────────────────┐         ┌──────────────────────────────────┐
│     Docker Container     │         │    Cloudflare Durable Object     │
│                          │         │                                  │
│  ┌────────────────────┐  │         │  ┌────────────────────────────┐ │
│  │  OpenCode Server   │  │         │  │     OpenCode Server        │ │
│  │  (port 4096)       │  │         │  │     (port 4096)            │ │
│  └────────────────────┘  │         │  └────────────────────────────┘ │
│  + nginx, ACP Gateway    │         │  + R2 workspace storage         │
│  + code-server           │         │  + Built-in hibernation         │
│  + Persistent workspace  │         │  + Pay-per-request              │
└──────────────────────────┘         └──────────────────────────────────┘
```

### Provider Selection Matrix

| Use Case | Provider | Reasoning |
|----------|----------|-----------|
| **Full development environment** | Docker | Persistent workspace, code-server, terminal |
| **Interactive coding session** | Docker | Long-running, file editing, Git integration |
| **Quick agent task** | Cloudflare | Wake-on-demand, fast response, cost-efficient |
| **Multi-agent team execution** | Cloudflare | Parallel instances, automatic scaling |
| **Batch processing** | Cloudflare | Ephemeral, pay-per-request |
| **CI/CD integration** | Cloudflare | Stateless, fast startup |
| **Mobile quick actions** | Cloudflare | Low latency, hibernate when done |

---

## Design Decisions

### 1. Session History: PostgreSQL Storage

**Decision:** Store all session history in AgentPod's PostgreSQL database.

**Rationale:**
- Session data is already synced via `opencode-sync.ts` service
- Enables seamless provider switching (Docker ↔ Cloudflare)
- Provides backup for ephemeral Cloudflare sandboxes
- Enables cross-device session continuity

**Implementation:**
- Existing `sync/opencode-sync.ts` already handles this
- Add sync triggers for Cloudflare sandbox events
- Store provider type in session metadata

### 2. File Persistence: Cloudflare R2

**Decision:** Use Cloudflare R2 for workspace file persistence.

**Rationale:**
- Native integration with Cloudflare Workers
- S3-compatible API (familiar patterns)
- Cost-effective for infrequent access
- Supports large files (up to 5TB)

**Implementation:**
```typescript
// Workspace sync to R2
interface WorkspaceStorage {
  // Save workspace to R2
  saveWorkspace(sandboxId: string, files: File[]): Promise<void>;
  
  // Load workspace from R2
  loadWorkspace(sandboxId: string): Promise<File[]>;
  
  // Sync changed files
  syncChanges(sandboxId: string, changes: FileChange[]): Promise<void>;
}
```

**Sync Strategy:**
1. On sandbox wake: Load workspace from R2
2. During execution: Track changed files in memory
3. On hibernate: Sync changed files to R2
4. On explicit save: Full workspace sync

### 3. Cost Model: Deferred

**Decision:** Address cost optimization in a later phase.

**Current approach:**
- Use Cloudflare's default pricing
- Monitor usage patterns
- Implement limits per user/tier

**Future considerations:**
- Pre-warming strategies for popular sandboxes
- Usage-based billing integration
- Cost allocation per user/project

---

## Technical Specifications

### Provider Interface

**File:** `/apps/api/src/services/providers/types.ts`

```typescript
import type { Config } from "@opencode-ai/sdk";

export type SandboxProviderType = "docker" | "cloudflare";

export interface SandboxProviderOptions {
  /** Unique identifier for the sandbox */
  id: string;
  /** User ID (owner) */
  userId: string;
  /** OpenCode configuration (providers, settings) */
  config?: Config;
  /** Working directory inside sandbox */
  directory?: string;
  /** Optional: Git repository to clone */
  gitUrl?: string;
  /** Optional: Branch to checkout */
  gitBranch?: string;
}

export interface SandboxInfo {
  id: string;
  status: "starting" | "running" | "stopped" | "sleeping" | "error";
  provider: SandboxProviderType;
  /** URL to access OpenCode (internal) */
  opencodeUrl?: string;
  /** When sandbox was last active */
  lastActiveAt?: Date;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface SandboxProvider {
  readonly type: SandboxProviderType;
  
  /** Create a new sandbox */
  createSandbox(options: SandboxProviderOptions): Promise<SandboxInfo>;
  
  /** Start/wake a sandbox */
  startSandbox(id: string): Promise<void>;
  
  /** Stop/hibernate a sandbox */
  stopSandbox(id: string): Promise<void>;
  
  /** Delete a sandbox and its resources */
  deleteSandbox(id: string): Promise<void>;
  
  /** Get sandbox info */
  getSandbox(id: string): Promise<SandboxInfo | null>;
  
  /** List sandboxes for a user */
  listSandboxes(userId: string): Promise<SandboxInfo[]>;
  
  /** Get OpenCode SDK client for a sandbox */
  getOpenCodeClient(id: string): Promise<OpenCodeClient>;
  
  /** Proxy a request to OpenCode (for web UI) */
  proxyRequest(id: string, request: Request): Promise<Response>;
  
  /** Health check */
  healthCheck(id: string): Promise<boolean>;
}

// Type for the OpenCode SDK client
type OpenCodeClient = ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>;
```

### Config Adapter

**File:** `/apps/api/src/services/providers/config-adapter.ts`

Converts between AgentPod's config format and Cloudflare SDK format:

```typescript
import type { Config } from "@opencode-ai/sdk";

/**
 * AgentPod stores auth as:
 * { "anthropic": { "type": "api", "key": "sk-..." } }
 * 
 * Cloudflare SDK expects:
 * { provider: { anthropic: { options: { apiKey: "sk-..." } } } }
 */

interface AgentPodAuth {
  [providerId: string]: {
    type: "api" | "oauth";
    key?: string;
    refresh?: string;
    access?: string;
    expires?: number;
  };
}

interface AgentPodUserConfig {
  settings?: Record<string, unknown>;
  agents_md?: string;
  files?: Array<{
    type: string;
    name: string;
    extension: string;
    content: string;
  }>;
}

export function agentPodToCloudflareConfig(
  auth: AgentPodAuth | null,
  userConfig: AgentPodUserConfig | null
): Config {
  const config: Config = {};
  
  // Convert auth credentials to Cloudflare format
  if (auth) {
    config.provider = {};
    for (const [providerId, credentials] of Object.entries(auth)) {
      if (credentials.type === "api" && credentials.key) {
        config.provider[providerId] = {
          options: { apiKey: credentials.key },
        };
      }
      // OAuth tokens require different handling (refresh flow)
    }
  }
  
  // Include user settings
  if (userConfig?.settings) {
    Object.assign(config, userConfig.settings);
  }
  
  return config;
}

export function cloudflareToAgentPodAuth(config: Config): AgentPodAuth {
  const auth: AgentPodAuth = {};
  
  if (config.provider) {
    for (const [providerId, providerConfig] of Object.entries(config.provider)) {
      const apiKey = providerConfig?.options?.apiKey;
      if (apiKey) {
        auth[providerId] = { type: "api", key: apiKey };
      }
    }
  }
  
  return auth;
}
```

### Cloudflare Worker

**File:** `/cloudflare/worker/src/index.ts`

```typescript
/**
 * Cloudflare Worker for AgentPod Dynamic Sandboxes
 * 
 * Routes:
 *   POST /sandbox              - Create new sandbox
 *   GET  /sandbox/:id          - Get sandbox info
 *   DELETE /sandbox/:id        - Delete sandbox
 *   POST /sandbox/:id/wake     - Wake hibernating sandbox
 *   ANY  /sandbox/:id/opencode/* - Proxy to OpenCode
 *   POST /sandbox/:id/message  - Send message (programmatic API)
 *   POST /sandbox/:id/sync     - Sync workspace to R2
 */

import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { 
  createOpencodeServer, 
  proxyToOpencode, 
  createOpencode,
  type OpencodeServer 
} from "@cloudflare/sandbox/opencode";
import type { Config, OpencodeClient } from "@opencode-ai/sdk";

export { Sandbox };

interface Env {
  Sandbox: DurableObjectNamespace;
  WORKSPACE_BUCKET: R2Bucket;  // R2 bucket for workspace storage
  AGENTPOD_API_URL: string;    // Management API URL for callbacks
  AGENTPOD_API_TOKEN: string;  // Auth token for API callbacks
}

// Active servers cache (per Worker instance)
const activeServers = new Map<string, OpencodeServer>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    
    try {
      // POST /sandbox - Create new sandbox
      if (request.method === "POST" && pathParts[0] === "sandbox" && !pathParts[1]) {
        return handleCreateSandbox(request, env);
      }
      
      // GET /sandbox/:id - Get sandbox info
      if (request.method === "GET" && pathParts[0] === "sandbox" && pathParts[1] && !pathParts[2]) {
        return handleGetSandbox(env, pathParts[1]);
      }
      
      // DELETE /sandbox/:id - Delete sandbox
      if (request.method === "DELETE" && pathParts[0] === "sandbox" && pathParts[1]) {
        return handleDeleteSandbox(env, pathParts[1]);
      }
      
      // POST /sandbox/:id/wake - Wake sandbox
      if (request.method === "POST" && pathParts[2] === "wake") {
        return handleWakeSandbox(request, env, pathParts[1]);
      }
      
      // ANY /sandbox/:id/opencode/* - Proxy to OpenCode
      if (pathParts[0] === "sandbox" && pathParts[2] === "opencode") {
        return handleOpenCodeProxy(request, env, pathParts[1]);
      }
      
      // POST /sandbox/:id/message - Send message
      if (request.method === "POST" && pathParts[2] === "message") {
        return handleSendMessage(request, env, pathParts[1]);
      }
      
      // POST /sandbox/:id/sync - Sync workspace to R2
      if (request.method === "POST" && pathParts[2] === "sync") {
        return handleSyncWorkspace(request, env, pathParts[1]);
      }
      
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Worker error:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    }
  },
};

// =============================================================================
// Handler Functions
// =============================================================================

async function handleCreateSandbox(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    id: string;
    userId: string;
    config: Config;
    directory?: string;
    gitUrl?: string;
    gitBranch?: string;
  };
  
  const sandboxId = body.id;
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const directory = body.directory || "/home/user/workspace";
  
  // Load workspace from R2 if exists
  const workspaceExists = await loadWorkspaceFromR2(env, sandboxId, sandbox, directory);
  
  // Clone repo if provided and workspace doesn't exist
  if (body.gitUrl && !workspaceExists) {
    await sandbox.gitCheckout(body.gitUrl, {
      targetDir: directory,
      branch: body.gitBranch,
    });
  }
  
  // Start OpenCode server
  const server = await createOpencodeServer(sandbox, {
    directory,
    config: body.config,
  });
  
  activeServers.set(sandboxId, server);
  
  // Notify AgentPod API of sandbox creation
  await notifyAgentPodAPI(env, "sandbox.created", {
    sandboxId,
    userId: body.userId,
    provider: "cloudflare",
  });
  
  return Response.json({
    success: true,
    sandboxId,
    status: "running",
    opencodeUrl: `/sandbox/${sandboxId}/opencode`,
  });
}

async function handleGetSandbox(env: Env, sandboxId: string): Promise<Response> {
  const hasServer = activeServers.has(sandboxId);
  
  // Check if workspace exists in R2
  const workspaceKey = `workspaces/${sandboxId}/`;
  const objects = await env.WORKSPACE_BUCKET.list({ prefix: workspaceKey, limit: 1 });
  const hasWorkspace = objects.objects.length > 0;
  
  return Response.json({
    sandboxId,
    status: hasServer ? "running" : "sleeping",
    hasWorkspace,
    provider: "cloudflare",
  });
}

async function handleDeleteSandbox(env: Env, sandboxId: string): Promise<Response> {
  // Stop server if running
  const server = activeServers.get(sandboxId);
  if (server) {
    await server.close();
    activeServers.delete(sandboxId);
  }
  
  // Delete workspace from R2
  const workspaceKey = `workspaces/${sandboxId}/`;
  const objects = await env.WORKSPACE_BUCKET.list({ prefix: workspaceKey });
  
  for (const obj of objects.objects) {
    await env.WORKSPACE_BUCKET.delete(obj.key);
  }
  
  return Response.json({ success: true, deleted: sandboxId });
}

async function handleWakeSandbox(
  request: Request, 
  env: Env, 
  sandboxId: string
): Promise<Response> {
  const body = await request.json() as { config?: Config };
  
  // Check if already running
  if (activeServers.has(sandboxId)) {
    return Response.json({ success: true, status: "already_running" });
  }
  
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const directory = "/home/user/workspace";
  
  // Load workspace from R2
  await loadWorkspaceFromR2(env, sandboxId, sandbox, directory);
  
  // Start OpenCode server
  const server = await createOpencodeServer(sandbox, {
    directory,
    config: body.config,
  });
  
  activeServers.set(sandboxId, server);
  
  return Response.json({ success: true, status: "running" });
}

async function handleOpenCodeProxy(
  request: Request,
  env: Env,
  sandboxId: string
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  
  // Get or create OpenCode server
  let server = activeServers.get(sandboxId);
  if (!server) {
    // Auto-wake on request
    await loadWorkspaceFromR2(env, sandboxId, sandbox, "/home/user/workspace");
    server = await createOpencodeServer(sandbox, {
      directory: "/home/user/workspace",
    });
    activeServers.set(sandboxId, server);
  }
  
  return proxyToOpencode(request, sandbox, server);
}

async function handleSendMessage(
  request: Request,
  env: Env,
  sandboxId: string
): Promise<Response> {
  const body = await request.json() as {
    sessionId?: string;
    message: string;
    model?: { providerID: string; modelID: string };
    config?: Config;
  };
  
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  
  // Get typed SDK client
  const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
    directory: "/home/user/workspace",
    config: body.config,
  });
  
  // Ensure server is cached
  if (!activeServers.has(sandboxId)) {
    activeServers.set(sandboxId, server);
  }
  
  // Create or reuse session
  let sessionId = body.sessionId;
  if (!sessionId) {
    const session = await client.session.create({
      body: { title: "Dynamic Agent Task" },
    });
    sessionId = session.data!.id;
  }
  
  // Send message
  const response = await client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text: body.message }],
      model: body.model,
    },
  });
  
  // Extract text response
  const parts = response.data?.parts ?? [];
  const textPart = parts.find((p: { type: string }) => p.type === "text") as 
    { text?: string } | undefined;
  
  // Notify AgentPod API for session sync
  await notifyAgentPodAPI(env, "session.message", {
    sandboxId,
    sessionId,
    provider: "cloudflare",
  });
  
  return Response.json({
    sessionId,
    response: textPart?.text ?? "",
    parts: response.data?.parts,
  });
}

async function handleSyncWorkspace(
  request: Request,
  env: Env,
  sandboxId: string
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  
  // Get list of files in workspace
  const files = await sandbox.listFiles("/home/user/workspace");
  
  // Upload each file to R2
  let syncedCount = 0;
  for (const file of files) {
    if (file.type === "file") {
      const content = await sandbox.readFile(file.path);
      const r2Key = `workspaces/${sandboxId}/${file.path}`;
      await env.WORKSPACE_BUCKET.put(r2Key, content);
      syncedCount++;
    }
  }
  
  return Response.json({ 
    success: true, 
    syncedFiles: syncedCount,
    sandboxId,
  });
}

// =============================================================================
// Helper Functions
// =============================================================================

async function loadWorkspaceFromR2(
  env: Env,
  sandboxId: string,
  sandbox: ReturnType<typeof getSandbox>,
  directory: string
): Promise<boolean> {
  const prefix = `workspaces/${sandboxId}/`;
  const objects = await env.WORKSPACE_BUCKET.list({ prefix });
  
  if (objects.objects.length === 0) {
    return false;
  }
  
  // Download and restore each file
  for (const obj of objects.objects) {
    const content = await env.WORKSPACE_BUCKET.get(obj.key);
    if (content) {
      const relativePath = obj.key.replace(prefix, "");
      const fullPath = `${directory}/${relativePath}`;
      await sandbox.writeFile(fullPath, await content.arrayBuffer());
    }
  }
  
  return true;
}

async function notifyAgentPodAPI(
  env: Env,
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    await fetch(`${env.AGENTPOD_API_URL}/api/v2/cloudflare/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.AGENTPOD_API_TOKEN}`,
      },
      body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
    });
  } catch (error) {
    console.error("Failed to notify AgentPod API:", error);
  }
}
```

### R2 Workspace Storage

**File:** `/cloudflare/worker/src/storage.ts`

```typescript
/**
 * R2-based workspace storage for Cloudflare sandboxes
 */

export interface WorkspaceFile {
  path: string;
  content: ArrayBuffer;
  lastModified: Date;
}

export class WorkspaceStorage {
  constructor(
    private bucket: R2Bucket,
    private sandboxId: string
  ) {}
  
  private getKey(path: string): string {
    return `workspaces/${this.sandboxId}/${path}`;
  }
  
  async saveFile(path: string, content: ArrayBuffer): Promise<void> {
    await this.bucket.put(this.getKey(path), content, {
      customMetadata: {
        lastModified: new Date().toISOString(),
      },
    });
  }
  
  async loadFile(path: string): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(this.getKey(path));
    if (!object) return null;
    return object.arrayBuffer();
  }
  
  async deleteFile(path: string): Promise<void> {
    await this.bucket.delete(this.getKey(path));
  }
  
  async listFiles(): Promise<string[]> {
    const prefix = `workspaces/${this.sandboxId}/`;
    const objects = await this.bucket.list({ prefix });
    return objects.objects.map(obj => obj.key.replace(prefix, ""));
  }
  
  async deleteAllFiles(): Promise<void> {
    const files = await this.listFiles();
    for (const file of files) {
      await this.deleteFile(file);
    }
  }
  
  async getLastModified(): Promise<Date | null> {
    const prefix = `workspaces/${this.sandboxId}/`;
    const objects = await this.bucket.list({ prefix, limit: 1 });
    
    if (objects.objects.length === 0) return null;
    
    // Find most recent modification
    let latest = new Date(0);
    for (const obj of objects.objects) {
      if (obj.uploaded > latest) {
        latest = obj.uploaded;
      }
    }
    
    return latest;
  }
}
```

---

## Database Schema Updates

### New Tables

```sql
-- Track dynamic agent tasks (Cloudflare sandboxes)
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'cloudflare',
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT NOT NULL,
  response TEXT,
  git_url TEXT,
  model_provider TEXT,
  model_id TEXT,
  session_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  error TEXT,
  metadata JSONB,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_tasks_user ON agent_tasks(user_id);
CREATE INDEX idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX idx_agent_tasks_sandbox ON agent_tasks(sandbox_id);

-- Track Cloudflare sandbox state
CREATE TABLE cloudflare_sandboxes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sleeping',
  worker_url TEXT NOT NULL,
  config_hash TEXT,
  workspace_synced_at TIMESTAMP,
  last_active_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_cloudflare_sandboxes_user ON cloudflare_sandboxes(user_id);
CREATE INDEX idx_cloudflare_sandboxes_status ON cloudflare_sandboxes(status);

-- Extend existing sandboxes table with provider type
ALTER TABLE sandboxes ADD COLUMN provider TEXT DEFAULT 'docker';
ALTER TABLE sandboxes ADD COLUMN cloudflare_sandbox_id TEXT;
```

---

## API Routes

### New Routes for Dynamic Agents

**File:** `/apps/api/src/routes/agents.ts`

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getCloudflareProvider } from "../services/providers/cloudflare-provider";
import { nanoid } from "nanoid";

export const agentRoutes = new Hono()
  /**
   * POST /api/v2/agents/task
   * Create and execute a dynamic agent task using Cloudflare sandbox
   */
  .post("/task", zValidator("json", z.object({
    userId: z.string(),
    message: z.string(),
    gitUrl: z.string().url().optional(),
    gitBranch: z.string().optional(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }).optional(),
    // Optional: reuse existing sandbox
    sandboxId: z.string().optional(),
  })), async (c) => {
    const body = c.req.valid("json");
    const taskId = nanoid(12);
    
    const provider = getCloudflareProvider();
    
    // Create or reuse sandbox
    let sandboxId = body.sandboxId;
    if (!sandboxId) {
      const sandbox = await provider.createSandbox({
        id: `task-${taskId}`,
        userId: body.userId,
        gitUrl: body.gitUrl,
      });
      sandboxId = sandbox.id;
    }
    
    // Get OpenCode client and send message
    const client = await provider.getOpenCodeClient(sandboxId);
    const session = await client.session.create({ body: {} });
    
    const response = await client.session.prompt({
      path: { id: session.data!.id },
      body: {
        parts: [{ type: "text", text: body.message }],
        model: body.model,
      },
    });
    
    // Store task in database
    // await createAgentTask({ taskId, sandboxId, ... });
    
    return c.json({
      taskId,
      sandboxId,
      sessionId: session.data!.id,
      response: response.data,
    });
  })
  
  /**
   * GET /api/v2/agents/task/:id
   * Get task status and response
   */
  .get("/task/:id", async (c) => {
    const taskId = c.req.param("id");
    // const task = await getAgentTask(taskId);
    // return c.json(task);
    return c.json({ taskId, status: "not_implemented" });
  })
  
  /**
   * POST /api/v2/agents/team
   * Execute a multi-agent team task
   */
  .post("/team", zValidator("json", z.object({
    userId: z.string(),
    agents: z.array(z.object({
      role: z.string(),
      message: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }).optional(),
    })),
    gitUrl: z.string().url().optional(),
  })), async (c) => {
    const body = c.req.valid("json");
    const teamId = nanoid(12);
    
    const provider = getCloudflareProvider();
    
    // Create sandboxes for each agent in parallel
    const sandboxPromises = body.agents.map(async (agent, index) => {
      const sandbox = await provider.createSandbox({
        id: `team-${teamId}-agent-${index}`,
        userId: body.userId,
        gitUrl: body.gitUrl,
      });
      
      const client = await provider.getOpenCodeClient(sandbox.id);
      const session = await client.session.create({ 
        body: { title: `${agent.role} Agent` } 
      });
      
      const response = await client.session.prompt({
        path: { id: session.data!.id },
        body: {
          parts: [{ type: "text", text: agent.message }],
          model: agent.model,
        },
      });
      
      return {
        role: agent.role,
        sandboxId: sandbox.id,
        sessionId: session.data!.id,
        response: response.data,
      };
    });
    
    const results = await Promise.all(sandboxPromises);
    
    return c.json({
      teamId,
      agents: results,
    });
  });
```

### Cloudflare Webhook Handler

**File:** `/apps/api/src/routes/cloudflare-webhook.ts`

```typescript
import { Hono } from "hono";
import { createLogger } from "../utils/logger";

const log = createLogger("cloudflare-webhook");

export const cloudflareWebhookRoutes = new Hono()
  /**
   * POST /api/v2/cloudflare/webhook
   * Receive events from Cloudflare Worker
   */
  .post("/webhook", async (c) => {
    const body = await c.req.json() as {
      event: string;
      data: Record<string, unknown>;
      timestamp: string;
    };
    
    log.info("Received Cloudflare webhook", { event: body.event });
    
    switch (body.event) {
      case "sandbox.created":
        // Update cloudflare_sandboxes table
        break;
        
      case "sandbox.hibernated":
        // Update status to 'sleeping'
        break;
        
      case "sandbox.woken":
        // Update status to 'running'
        break;
        
      case "session.message":
        // Trigger session sync to PostgreSQL
        break;
        
      case "workspace.synced":
        // Update workspace_synced_at
        break;
    }
    
    return c.json({ received: true });
  });
```

---

## Configuration

### Environment Variables

```bash
# =============================================================================
# Cloudflare Configuration
# =============================================================================

# Cloudflare account credentials
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token

# Worker URL (deployed Worker endpoint)
CLOUDFLARE_WORKER_URL=https://agentpod-sandbox.your-worker.workers.dev

# R2 bucket name for workspace storage
CLOUDFLARE_R2_BUCKET=agentpod-workspaces

# =============================================================================
# Feature Flags
# =============================================================================

# Enable Cloudflare sandbox provider
ENABLE_CLOUDFLARE_SANDBOXES=true

# Default provider for new sandboxes ('docker' | 'cloudflare')
DEFAULT_SANDBOX_PROVIDER=docker

# Auto-select provider based on task type
AUTO_SELECT_PROVIDER=true
```

### Wrangler Configuration

**File:** `/cloudflare/wrangler.toml`

```toml
name = "agentpod-sandbox"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[durable_objects]
bindings = [
  { name = "Sandbox", class_name = "Sandbox" }
]

[[r2_buckets]]
binding = "WORKSPACE_BUCKET"
bucket_name = "agentpod-workspaces"

[vars]
AGENTPOD_API_URL = "https://api.agentpod.dev"

# Secrets (set via `wrangler secret put`)
# AGENTPOD_API_TOKEN = "..."
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

| Task | Description | Files |
|------|-------------|-------|
| Create provider interface | Define `SandboxProvider` types | `services/providers/types.ts` |
| Refactor Docker provider | Extract to `DockerSandboxProvider` class | `services/providers/docker-provider.ts` |
| Create config adapter | AgentPod ↔ Cloudflare format conversion | `services/providers/config-adapter.ts` |
| Database schema | Add new tables and columns | `db/migrations/` |

### Phase 2: Cloudflare Worker (Week 2-3)

| Task | Description | Files |
|------|-------------|-------|
| Worker scaffold | Basic Cloudflare Worker setup | `cloudflare/worker/` |
| OpenCode integration | `createOpencodeServer()` + proxy | `cloudflare/worker/src/index.ts` |
| R2 storage | Workspace persistence | `cloudflare/worker/src/storage.ts` |
| Wrangler config | Deployment configuration | `cloudflare/wrangler.toml` |

### Phase 3: API Integration (Week 3-4)

| Task | Description | Files |
|------|-------------|-------|
| Cloudflare provider | Implement `CloudflareSandboxProvider` | `services/providers/cloudflare-provider.ts` |
| Agent routes | `/api/v2/agents/task` endpoint | `routes/agents.ts` |
| Webhook handler | Receive Cloudflare events | `routes/cloudflare-webhook.ts` |
| Provider factory | Auto-select provider | `services/providers/index.ts` |

### Phase 4: Session Sync (Week 4-5)

| Task | Description | Files |
|------|-------------|-------|
| Extend sync service | Support Cloudflare sessions | `services/sync/opencode-sync.ts` |
| Session migration | Move sessions between providers | `services/session-migration.ts` |
| Webhook processing | Handle session events | `routes/cloudflare-webhook.ts` |

### Phase 5: Testing & Polish (Week 5-6)

| Task | Description | Files |
|------|-------------|-------|
| Unit tests | Provider interface tests | `tests/providers/` |
| Integration tests | End-to-end workflow tests | `tests/e2e/cloudflare.test.ts` |
| Documentation | Update API docs | `docs/api/` |
| Monitoring | Add metrics and logging | `services/providers/` |

---

## Frontend Changes

### Minimal Required Changes

The existing Chat UI should work with minimal changes because both providers use the same `@opencode-ai/sdk` types.

### New UI Elements

1. **Provider Badge**: Show sandbox type (Docker 💻 / Cloudflare ☁️)
2. **Quick Task Button**: "Run as agent task" for Cloudflare execution
3. **Status Indicator**: Show "Sleeping" state for hibernating sandboxes
4. **Wake Button**: Manually wake a sleeping Cloudflare sandbox

### Svelte Component Example

```svelte
<!-- SandboxProviderBadge.svelte -->
<script lang="ts">
  export let provider: "docker" | "cloudflare";
  export let status: string;
</script>

<span class="badge" class:cloudflare={provider === "cloudflare"}>
  {#if provider === "docker"}
    💻 Docker
  {:else}
    ☁️ Cloudflare
    {#if status === "sleeping"}
      <span class="status">(sleeping)</span>
    {/if}
  {/if}
</span>

<style>
  .badge {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    background: var(--muted);
  }
  .cloudflare {
    background: linear-gradient(135deg, #f38020, #f9a03f);
    color: white;
  }
  .status {
    opacity: 0.8;
    font-style: italic;
  }
</style>
```

---

## Security Considerations

### Authentication

1. **Worker Authentication**: All requests to Cloudflare Worker must include API token
2. **Webhook Verification**: Verify webhook signatures from Cloudflare
3. **User Isolation**: Each user's sandboxes are isolated by ID prefix

### Secrets Management

1. **API Keys**: Store in Cloudflare Secrets (not in code)
2. **User Credentials**: Encrypted in PostgreSQL, decrypted at runtime
3. **R2 Access**: Scoped to worker, no public access

### Data Protection

1. **Workspace Encryption**: Consider encrypting R2 objects at rest
2. **Session Data**: Stored in PostgreSQL with row-level security
3. **Audit Logging**: Log all sandbox operations

---

## Monitoring & Observability

### Metrics to Track

| Metric | Description |
|--------|-------------|
| `cloudflare_sandbox_created` | New sandbox creations |
| `cloudflare_sandbox_wake_latency` | Time to wake from sleep |
| `cloudflare_sandbox_message_latency` | Time to process message |
| `cloudflare_r2_sync_duration` | Workspace sync time |
| `cloudflare_r2_storage_bytes` | Total storage used |

### Logging

```typescript
// Structured logging for Cloudflare operations
log.info("Cloudflare sandbox created", {
  sandboxId,
  userId,
  provider: "cloudflare",
  hasGitUrl: !!gitUrl,
});
```

---

## Rollback Plan

If Cloudflare integration causes issues:

1. **Feature Flag**: Disable `ENABLE_CLOUDFLARE_SANDBOXES=false`
2. **Auto-Migration**: Move active Cloudflare sessions to Docker
3. **R2 Export**: Export workspaces to local storage
4. **Database Cleanup**: Mark Cloudflare sandboxes as deprecated

---

## Open Questions

1. **OAuth Refresh**: How to handle OAuth token refresh in Cloudflare sandboxes?
2. **Large Workspaces**: What's the practical limit for R2 workspace size?
3. **Multi-Region**: Should we deploy Workers to multiple regions?
4. **Pricing Tiers**: How to tie Cloudflare usage to user subscription tiers?

---

## Related Documents

- [Autonomous Sandboxes](./autonomous-sandboxes.md) - Autonomous agent execution patterns
- [OpenCode SDK Analysis](../implementation/opencode-sdk-analysis.md) - SDK capabilities
- [OpenCode Config Architecture](../implementation/opencode-config-architecture.md) - Config injection
- [Sandbox Environment Patterns](../research/sandbox-environment-patterns.md) - Container patterns

---

## References

- [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
- [OpenCode AI SDK](https://www.npmjs.com/package/@opencode-ai/sdk)
