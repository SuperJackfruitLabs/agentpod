# Technical Architecture

Deep dive into the system design for the Portable Command Center.

---

## Table of Contents

- [System Overview](#system-overview)
- [Component Details](#component-details)
  - [Management API](#management-api)
  - [Mobile App (Tauri)](#mobile-app-tauri)
  - [OpenCode Containers](#opencode-containers)
  - [Coolify Integration](#coolify-integration)
  - [Forgejo Integration](#forgejo-integration)
- [Data Models](#data-models)
- [API Specifications](#api-specifications)
- [Authentication Flows](#authentication-flows)
- [Deployment](#deployment)
- [Security](#security)

---

## System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TAILSCALE MESH VPN                                │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         HETZNER VPS                                 │    │
│  │                    100.x.x.1 (Tailscale)                            │    │
│  │                    public.domain.com (Internet)                     │    │
│  │                                                                     │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │                       COOLIFY                                │    │    │
│  │  │  • Docker orchestration                                      │    │    │
│  │  │  • Traefik reverse proxy                                     │    │    │
│  │  │  • API: http://100.x.x.1:8000/api/v1                         │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  │                              │                                      │    │
│  │  ┌───────────┬───────────────┼───────────────┬───────────┐          │    │
│  │  │           │               │               │           │          │    │
│  │  ▼           ▼               ▼               ▼           ▼          │    │
│  │  ┌─────┐   ┌─────┐      ┌─────────┐      ┌─────┐   ┌─────┐         │    │
│  │  │Forge│   │Mgmt │      │OpenCode │      │OCode│   │OCode│         │    │
│  │  │ jo  │   │ API │      │Proj A   │      │ B   │   │ C   │         │    │
│  │  │:3000│   │:3001│      │:4001    │      │:4002│   │:4003│         │    │
│  │  └─────┘   └─────┘      └─────────┘      └─────┘   └─────┘         │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│                         ┌──────────────────────┐                            │
│                         │     MOBILE APP       │                            │
│                         │     100.x.x.10       │                            │
│                         │                      │                            │
│                         │  ┌────────────────┐  │                            │
│                         │  │  Tauri Rust    │  │                            │
│                         │  │  Backend       │  │                            │
│                         │  │  • OAuth Proxy │  │                            │
│                         │  │  • API Client  │  │                            │
│                         │  └────────────────┘  │                            │
│                         │  ┌────────────────┐  │                            │
│                         │  │  Svelte        │  │                            │
│                         │  │  Frontend      │  │                            │
│                         │  └────────────────┘  │                            │
│                         └──────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Communication Patterns

| From | To | Protocol | Purpose |
|------|-----|----------|---------|
| Mobile App | Management API | HTTP/REST | Project CRUD, orchestration |
| Mobile App | OpenCode | HTTP/REST + SSE | Chat, real-time events |
| Management API | Coolify API | HTTP/REST | Container management |
| Management API | Forgejo API | HTTP/REST | Git operations |
| OpenCode | Forgejo | Git/SSH | Clone, push code |

---

## Component Details

### Management API

**Purpose**: Central orchestration service for project lifecycle, credential management, and background operations.

**Technology**: Bun/TypeScript with Hono (SST team's framework choice)

**Port**: 3001

#### Responsibilities

1. **Project Lifecycle**
   - Create project (repo + container)
   - Import from GitHub/GitLab
   - Delete project (cleanup)
   
2. **Container Management**
   - Wrapper around Coolify API
   - Start/stop/restart containers
   - Health monitoring
   
3. **Credential Management**
   - Store LLM API keys in Coolify env vars
   - Manage Forgejo access tokens
   - GitHub sync tokens

4. **GitHub Sync**
   - Pull from GitHub to Forgejo
   - Push from Forgejo to GitHub
   - Handle conflicts

5. **Background Operations**
   - Queue long-running tasks
   - Track progress
   - Send notifications

#### Directory Structure

```
management-api/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config.ts                # Configuration
│   ├── routes/
│   │   ├── projects.ts          # Project CRUD
│   │   ├── containers.ts        # Container management
│   │   ├── providers.ts         # LLM provider config
│   │   ├── sync.ts              # GitHub sync
│   │   └── health.ts            # Health checks
│   ├── services/
│   │   ├── coolify.ts           # Coolify API client
│   │   ├── forgejo.ts           # Forgejo API client
│   │   ├── github.ts            # GitHub API client
│   │   └── opencode.ts          # OpenCode health checks
│   ├── models/
│   │   ├── project.ts           # Project data model
│   │   └── provider.ts          # Provider config model
│   └── utils/
│       ├── logger.ts
│       └── errors.ts
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

### Mobile App (Tauri)

**Purpose**: Native mobile interface for interacting with the system.

**Technology**: Tauri v2 (Rust backend) + Svelte (frontend)

#### Rust Backend Modules

```rust
// src-tauri/src/lib.rs

mod oauth;       // OAuth proxy for LLM providers
mod api;         // API client wrappers
mod storage;     // Secure credential storage
mod push;        // Push notification handling

// Commands exposed to frontend
#[tauri::command]
async fn list_projects() -> Result<Vec<Project>, Error>;

#[tauri::command]
async fn create_project(name: String, server: String) -> Result<Project, Error>;

#[tauri::command]
async fn send_prompt(project_id: String, prompt: String) -> Result<Message, Error>;

#[tauri::command]
async fn initiate_oauth(provider: String) -> Result<OAuthChallenge, Error>;

#[tauri::command]
async fn poll_oauth(provider: String, device_code: String) -> Result<Option<Token>, Error>;
```

#### OAuth Proxy Implementation

```rust
// src-tauri/src/oauth.rs

pub mod github_copilot {
    const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
    const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
    const CLIENT_ID: &str = "Iv1.xxxxx"; // GitHub Copilot client ID

    pub async fn initiate() -> Result<DeviceCodeResponse, Error> {
        // POST to device code endpoint
        // Returns: device_code, user_code, verification_uri
    }

    pub async fn poll(device_code: &str) -> Result<Option<TokenResponse>, Error> {
        // Poll token endpoint until user completes auth
        // Returns: access_token when ready
    }
}

pub mod anthropic {
    pub async fn initiate() -> Result<AuthUrlResponse, Error> {
        // Return OAuth authorization URL
    }

    pub async fn exchange_code(code: &str) -> Result<TokenResponse, Error> {
        // Exchange auth code for token
    }
}
```

#### Svelte Frontend Structure

```
src/
├── routes/
│   ├── +layout.svelte           # App shell, navigation
│   ├── +page.svelte             # Home / Projects list
│   ├── projects/
│   │   ├── +page.svelte         # Projects list
│   │   ├── new/
│   │   │   └── +page.svelte     # Create project
│   │   └── [id]/
│   │       ├── +page.svelte     # Project detail / chat
│   │       ├── files/
│   │       │   ├── +page.svelte     # File browser
│   │       │   └── [...path]/
│   │       │       └── +page.svelte # File viewer (dynamic route)
│   │       ├── settings/
│   │       │   └── +page.svelte # Project settings
│   │       └── sync/
│   │           └── +page.svelte # GitHub sync
│   ├── servers/
│   │   └── +page.svelte         # Server status
│   └── settings/
│       ├── +page.svelte         # Settings home
│       └── providers/
│           └── +page.svelte     # LLM providers
├── lib/
│   ├── components/
│   │   ├── Chat.svelte          # Chat interface
│   │   ├── Message.svelte       # Single message
│   │   ├── ProjectCard.svelte   # Project list item
│   │   ├── ServerStatus.svelte  # Server indicator
│   │   ├── FileBrowser.svelte   # File tree navigation
│   │   ├── FileViewer.svelte    # Syntax-highlighted file view
│   │   └── FileReference.svelte # @ file picker for chat
│   ├── stores/
│   │   ├── projects.ts          # Projects state
│   │   ├── auth.ts              # Auth state
│   │   └── settings.ts          # Settings state
│   └── api/
│       ├── management.ts        # Management API client
│       └── opencode.ts          # OpenCode API client
└── app.html
```

---

### OpenCode Containers

**Purpose**: Individual AI coding agent instances, one per project.

**Base Image**: Custom Docker image with OpenCode pre-installed.

#### Dockerfile

```dockerfile
FROM node:20-slim

# Install OpenCode
RUN npm install -g opencode-ai

# Install git for repo operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Create workspace directory
WORKDIR /workspace

# Default environment variables (overridden by Coolify)
ENV OPENCODE_PORT=4096
ENV OPENCODE_HOST=0.0.0.0

# Startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 4096

ENTRYPOINT ["/entrypoint.sh"]
```

#### Entrypoint Script

```bash
#!/bin/bash
# entrypoint.sh

# Clone project from Forgejo if not already present
if [ ! -d "/workspace/.git" ]; then
    echo "Cloning project from Forgejo..."
    git clone "$FORGEJO_REPO_URL" /workspace
fi

# Configure git
git config --global user.email "opencode@local"
git config --global user.name "OpenCode"

# Start OpenCode server
cd /workspace
exec opencode serve --port $OPENCODE_PORT --hostname $OPENCODE_HOST
```

#### Environment Variables (Set by Coolify)

| Variable | Description | Example |
|----------|-------------|---------|
| `FORGEJO_REPO_URL` | Git clone URL | `http://forgejo:3000/user/repo.git` |
| `OPENCODE_PORT` | Server port | `4096` |
| `OPENCODE_HOST` | Bind address | `0.0.0.0` |
| `ANTHROPIC_API_KEY` | Anthropic API key | `sk-ant-xxx` |
| `OPENAI_API_KEY` | OpenAI API key | `sk-xxx` |
| `OPENROUTER_API_KEY` | OpenRouter API key | `sk-or-xxx` |
| `GITHUB_COPILOT_TOKEN` | GitHub Copilot token | `ghu_xxx` |

---

### Coolify Integration

**Purpose**: Container orchestration and environment management.

#### API Endpoints Used

```typescript
// Coolify API client

interface CoolifyClient {
  // Servers
  listServers(): Promise<Server[]>;
  getServer(uuid: string): Promise<Server>;
  
  // Applications (Containers)
  listApplications(): Promise<Application[]>;
  createDockerImageApp(config: DockerImageConfig): Promise<Application>;
  getApplication(uuid: string): Promise<Application>;
  deleteApplication(uuid: string): Promise<void>;
  startApplication(uuid: string): Promise<void>;
  stopApplication(uuid: string): Promise<void>;
  restartApplication(uuid: string): Promise<void>;
  
  // Environment Variables
  listEnvs(appUuid: string): Promise<EnvVar[]>;
  createEnv(appUuid: string, env: EnvVar): Promise<EnvVar>;
  updateEnv(appUuid: string, envUuid: string, env: EnvVar): Promise<EnvVar>;
  deleteEnv(appUuid: string, envUuid: string): Promise<void>;
  
  // Projects (Coolify concept, not our "projects")
  listProjects(): Promise<CoolifyProject[]>;
  createProject(name: string): Promise<CoolifyProject>;
}

interface DockerImageConfig {
  project_uuid: string;
  server_uuid: string;
  environment_name: string;
  docker_registry_image_name: string;
  docker_registry_image_tag: string;
  ports_exposes: string;
  name: string;
  description?: string;
}
```

#### Server Setup (One-time)

1. **Create Coolify Project for OpenCode:**
   - All OpenCode containers go under one Coolify project
   - Separate environments per project (optional)

---

### Forgejo Integration

**Purpose**: Git repository management, version control, GitHub sync.

#### API Endpoints Used

```typescript
// Forgejo API client (compatible with Gitea API)

interface ForgejoClient {
  // Repositories
  listRepos(): Promise<Repository[]>;
  createRepo(config: RepoConfig): Promise<Repository>;
  getRepo(owner: string, repo: string): Promise<Repository>;
  deleteRepo(owner: string, repo: string): Promise<void>;
  
  // Repository content
  getContents(owner: string, repo: string, path: string): Promise<Content[]>;
  
  // Mirroring
  createMirror(config: MirrorConfig): Promise<Repository>;
  syncMirror(owner: string, repo: string): Promise<void>;
}

interface RepoConfig {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
}

interface MirrorConfig {
  clone_addr: string;          // GitHub URL
  repo_name: string;
  mirror: boolean;
  private?: boolean;
  auth_username?: string;
  auth_password?: string;      // GitHub PAT
}
```

---

## Data Models

### Project

```typescript
interface Project {
  id: string;                    // UUID
  name: string;                  // Display name
  slug: string;                  // URL-safe name
  description?: string;
  
  // Forgejo repo
  forgejoRepoUrl: string;
  forgejoRepoId: number;
  
  // Coolify container
  coolifyAppUuid: string;
  coolifyServerUuid: string;
  containerPort: number;
  
  // GitHub sync (optional)
  githubRepoUrl?: string;
  githubSyncEnabled: boolean;
  githubSyncDirection: 'pull' | 'push' | 'bidirectional';
  lastSyncAt?: Date;
  
  // LLM config
  llmProvider?: string;          // Override, null = use default
  
  // Status
  status: 'creating' | 'running' | 'stopped' | 'error';
  createdAt: Date;
  updatedAt: Date;
}
```

### LLM Provider Config

```typescript
interface LLMProviderConfig {
  id: string;                    // Provider ID (anthropic, openai, etc.)
  name: string;                  // Display name
  type: 'api_key' | 'oauth';
  isConfigured: boolean;
  isDefault: boolean;
  
  // For API key providers
  apiKey?: string;               // Stored encrypted or in Coolify
  
  // For OAuth providers
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
}
```

### Server

```typescript
interface Server {
  id: string;
  name: string;
  tailscaleIp: string;
  coolifyUuid: string;
  status: 'online' | 'offline' | 'unknown';
  resources: {
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
  };
}
```

---

## API Specifications

### Management API

#### Projects

```yaml
# Create Project
POST /api/projects
Content-Type: application/json

{
  "name": "my-project",
  "description": "A new project",
  "serverUuid": "xxx-xxx-xxx",
  "llmProvider": "openrouter",  // optional, uses default if not set
  "source": {
    "type": "empty" | "github",
    "githubUrl": "https://github.com/user/repo",  // if type=github
    "syncEnabled": true,
    "syncDirection": "bidirectional"
  }
}

Response: 201 Created
{
  "id": "proj_xxx",
  "name": "my-project",
  "status": "creating",
  ...
}

# List Projects
GET /api/projects

Response: 200 OK
{
  "projects": [...]
}

# Get Project
GET /api/projects/:id

# Delete Project
DELETE /api/projects/:id

# Start Project Container
POST /api/projects/:id/start

# Stop Project Container
POST /api/projects/:id/stop
```

#### Providers

```yaml
# List Configured Providers
GET /api/providers

Response: 200 OK
{
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "type": "api_key",
      "isConfigured": true,
      "isDefault": true
    },
    {
      "id": "github-copilot",
      "name": "GitHub Copilot",
      "type": "oauth",
      "isConfigured": false,
      "isDefault": false
    }
  ]
}

# Configure API Key Provider
POST /api/providers/:id/configure
{
  "apiKey": "sk-xxx"
}

# Set Default Provider
POST /api/providers/:id/set-default

# Remove Provider
DELETE /api/providers/:id
```

#### GitHub Sync

```yaml
# Sync Project with GitHub
POST /api/projects/:id/sync
{
  "direction": "push" | "pull"
}

Response: 200 OK
{
  "status": "success",
  "commits": 5,
  "message": "Pushed 5 commits to GitHub"
}

# Or if conflict:
Response: 409 Conflict
{
  "status": "conflict",
  "conflicts": [...]
}
```

### OpenCode File APIs

The mobile app communicates directly with OpenCode containers for file operations.

```yaml
# List/Search Files
GET /find?pattern=*.ts&path=src

Response: 200 OK
{
  "files": [
    {
      "path": "src/index.ts",
      "type": "file",
      "size": 1234,
      "modified": "2024-12-05T10:30:00Z"
    },
    {
      "path": "src/utils.ts",
      "type": "file",
      "size": 567,
      "modified": "2024-12-04T15:20:00Z"
    }
  ]
}

# Get File Contents
GET /file?path=src/index.ts

Response: 200 OK
{
  "path": "src/index.ts",
  "content": "import { app } from './app';\n\napp.listen(3000);",
  "size": 1234,
  "modified": "2024-12-05T10:30:00Z",
  "language": "typescript"
}

# Get File/Directory Status (Git)
GET /file/status

Response: 200 OK
{
  "status": {
    "staged": ["src/new-file.ts"],
    "modified": ["src/index.ts"],
    "untracked": ["temp.log"]
  }
}

# Get Directory Tree
GET /find?path=.&depth=2

Response: 200 OK
{
  "tree": {
    "name": ".",
    "type": "directory",
    "children": [
      {
        "name": "src",
        "type": "directory",
        "children": [
          { "name": "index.ts", "type": "file" },
          { "name": "utils.ts", "type": "file" }
        ]
      },
      { "name": "package.json", "type": "file" },
      { "name": "README.md", "type": "file" }
    ]
  }
}
```

**File Viewer Features:**

| Feature | Implementation |
|---------|----------------|
| Syntax Highlighting | Client-side using Shiki or Prism.js |
| Line Numbers | Rendered in FileViewer component |
| Search in File | Client-side text search |
| Copy Path | Native clipboard API |
| File Reference (@) | Insert path into chat input |

---

## Authentication Flows

### GitHub Copilot OAuth (Device Flow)

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│  Mobile  │                    │  Tauri   │                    │  GitHub  │
│   App    │                    │ Backend  │                    │          │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │                               │                               │
     │  1. initiate_oauth("github")  │                               │
     │──────────────────────────────>│                               │
     │                               │                               │
     │                               │  2. POST /login/device/code   │
     │                               │──────────────────────────────>│
     │                               │                               │
     │                               │  3. {device_code, user_code}  │
     │                               │<──────────────────────────────│
     │                               │                               │
     │  4. {user_code, url}          │                               │
     │<──────────────────────────────│                               │
     │                               │                               │
     │  5. User opens URL, enters code                               │
     │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─>│
     │                               │                               │
     │  6. poll_oauth(device_code)   │                               │
     │──────────────────────────────>│                               │
     │                               │                               │
     │                               │  7. POST /oauth/access_token  │
     │                               │  (poll until ready)           │
     │                               │──────────────────────────────>│
     │                               │                               │
     │                               │  8. {access_token}            │
     │                               │<──────────────────────────────│
     │                               │                               │
     │  9. {access_token}            │                               │
     │<──────────────────────────────│                               │
     │                               │                               │
     │  10. Store token, save to     │                               │
     │      Management API           │                               │
     │──────────────────────────────>│                               │
```

### Anthropic Claude Pro/Max OAuth

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│  Mobile  │                    │  Tauri   │                    │Anthropic │
│   App    │                    │ Backend  │                    │          │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │                               │                               │
     │  1. initiate_oauth("claude")  │                               │
     │──────────────────────────────>│                               │
     │                               │                               │
     │  2. Generate auth URL         │                               │
     │<──────────────────────────────│                               │
     │                               │                               │
     │  3. Open auth URL in WebView/Browser                          │
     │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─>│
     │                               │                               │
     │  4. User authenticates        │                               │
     │                               │                               │
     │  5. Redirect to app deep link with code                       │
     │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
     │                               │                               │
     │  6. exchange_code(code)       │                               │
     │──────────────────────────────>│                               │
     │                               │                               │
     │                               │  7. Exchange code for token   │
     │                               │──────────────────────────────>│
     │                               │                               │
     │                               │  8. {access_token}            │
     │                               │<──────────────────────────────│
     │                               │                               │
     │  9. {access_token}            │                               │
     │<──────────────────────────────│                               │
```

---

## Deployment

### Docker Images to Build

| Image | Purpose | Registry |
|-------|---------|----------|
| `opencode-server` | OpenCode container | Docker Hub or private |
| `management-api` | Management API | Docker Hub or private |

### Coolify Deployment Steps

1. **Deploy Forgejo** (one-click service in Coolify)
2. **Deploy Management API**
   - Docker image from registry
   - Environment variables for Coolify/Forgejo URLs
3. **OpenCode containers created dynamically via API**

### Infrastructure Setup

```bash
# 1. Hetzner VPS (already has Coolify)

# 2. Install Tailscale on VPS
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# 3. Deploy Forgejo via Coolify
# - One-click service

# 4. Deploy Management API via Coolify
# - Docker image application

# 5. OpenCode containers created dynamically via Management API
```

---

## Security

### Network Security

- **Tailscale**: All traffic encrypted, zero-trust
- **No public ports**: Only Tailscale IPs accessible
- **Coolify Traefik**: SSL for public endpoints (if any)

### Credential Storage

| Credential | Storage Location | Encryption |
|------------|-----------------|------------|
| Management API token | Mobile Keychain/Keystore | OS-level |
| LLM API keys | Coolify env vars | At rest |
| GitHub tokens | Coolify env vars | At rest |
| Forgejo tokens | Management API DB | Application-level |

### Authentication

- **Mobile App ↔ Management API**: Bearer token
- **Management API ↔ Coolify**: Coolify API token
- **Management API ↔ Forgejo**: Forgejo API token
- **OpenCode ↔ LLM**: Provider-specific (API key or OAuth token)

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Unauthorized access | Tailscale auth, API tokens |
| Token theft | Secure storage, token rotation |
| Man-in-the-middle | Tailscale encryption |
| Container escape | Docker isolation, non-root user |
| Credential exposure | Env vars, not in code/logs |

---

*Document created: December 2024*
*Last updated: December 2024*
