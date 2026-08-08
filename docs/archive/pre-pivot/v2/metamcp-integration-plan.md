# MetaMCP Integration Plan for AgentPod

> **Date**: January 2026  
> **Status**: Research Complete - Ready for Implementation  
> **Priority**: High

## Executive Summary

This document outlines the integration of [MetaMCP](https://github.com/metatool-ai/metamcp) into AgentPod to provide a unified MCP server management layer. MetaMCP acts as an aggregator, orchestrator, middleware, and gateway for multiple MCP servers, enabling dynamic composition and exposure through unified endpoints.

---

## 1. What is MetaMCP?

**MetaMCP** is an MCP proxy that:
- **Aggregates** multiple MCP servers into a unified endpoint
- **Orchestrates** server lifecycle and connections
- **Provides Middleware** for transforming requests/responses
- **Acts as Gateway** with authentication (API keys, OAuth, OIDC)

### Core Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MetaMCP                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ MCP Server 1│  │ MCP Server 2│  │ MCP Server N│              │
│  │   (STDIO)   │  │   (SSE)     │  │   (HTTP)    │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          ▼                                       │
│                    ┌─────────────┐                               │
│                    │  Namespace  │  (grouping + tool filtering)  │
│                    └──────┬──────┘                               │
│                           ▼                                       │
│                    ┌─────────────┐                               │
│                    │  Endpoint   │  (auth + transport)           │
│                    └──────┬──────┘                               │
└───────────────────────────┼─────────────────────────────────────┘
                            ▼
              ┌─────────────────────────────┐
              │  Unified MCP Output          │
              │  /metamcp/{endpoint}/mcp     │  (Streamable HTTP)
              │  /metamcp/{endpoint}/sse     │  (SSE)
              │  /metamcp/{endpoint}/api     │  (OpenAPI)
              └─────────────────────────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **MCP Server** | Configuration for an upstream MCP server (STDIO, SSE, or Streamable HTTP) |
| **Namespace** | Groups multiple MCP servers, enables/disables tools, applies middleware |
| **Endpoint** | Exposes a namespace via authenticated URL (SSE/HTTP/OpenAPI) |
| **Middleware** | Intercepts and transforms MCP requests/responses |

---

## 2. MCP Servers with Different Auth & Connection Strategies

Based on research, here are **10 MCP servers** demonstrating diverse authentication and transport patterns:

### 2.1 OAuth2/OAuth Authentication

| Server | Transport | Auth Method | Key Features |
|--------|-----------|-------------|--------------|
| **GitHub MCP Server** (`github/github-mcp-server`) | STDIO | OAuth2 (GitHub App) | Personal Access Token or GitHub OAuth App |
| **Infisical MCP** (`Infisical/infisical`) | HTTP | OAuth2 with stored credentials | Dynamic OAuth flow with stored client ID/secret |
| **Remote MCP with GitHub OAuth** (`coleam00/remote-mcp-server-with-auth`) | Streamable HTTP | GitHub OAuth | PKCE, Cloudflare Workers, role-based access |

**Configuration Example (GitHub OAuth)**:
```json
{
  "mcpServers": {
    "github-oauth": {
      "type": "STREAMABLE_HTTP",
      "url": "https://mcp-server.workers.dev/mcp",
      "oauth": {
        "clientId": "your-github-client-id",
        "scope": "repo,read:user"
      }
    }
  }
}
```

### 2.2 API Key Authentication

| Server | Transport | Auth Method | Key Features |
|--------|-----------|-------------|--------------|
| **Context7** (`context7.com`) | Streamable HTTP | API Key (optional) | No auth required for public docs |
| **Exa AI** | HTTP | API Key in header | `Authorization: Bearer sk_xxx` |
| **Sentry MCP** (`getsentry/sentry-mcp`) | HTTP | Bearer Token | Organization-level API keys |

**Configuration Example (API Key)**:
```json
{
  "mcpServers": {
    "exa-search": {
      "type": "STDIO",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-exa"],
      "env": {
        "EXA_API_KEY": "${EXA_API_KEY}"
      }
    }
  }
}
```

### 2.3 Bearer Token Authentication

| Server | Transport | Auth Method | Key Features |
|--------|-----------|-------------|--------------|
| **MetaMCP Endpoints** | SSE/HTTP | Bearer Token | API keys with `sk_mt_` prefix |
| **OpenAI MCP** | HTTP | Bearer Token | Standard OpenAI API key format |

**Configuration Example (Bearer Token)**:
```json
{
  "mcpServers": {
    "remote-server": {
      "type": "SSE",
      "url": "https://example.com/mcp/sse",
      "bearerToken": "your-bearer-token",
      "headers": {
        "X-Custom-Header": "value"
      }
    }
  }
}
```

### 2.4 SSE (Server-Sent Events) Transport

| Server | Transport | Auth Method | Key Features |
|--------|-----------|-------------|--------------|
| **Ory MCP-SSE** (`ory/mcp-sse`) | SSE | API Key | Authentication platform integration |
| **MQTTX MCP SSE** (`ysfscream/mqttx-mcp-sse-server`) | SSE | None | MQTT operations over SSE |
| **MCP-SSE-Server-Sample** | SSE | Optional Bearer | Reference implementation |

### 2.5 STDIO Transport (Most Common)

| Server | Transport | Auth Method | Key Features |
|--------|-----------|-------------|--------------|
| **Filesystem MCP** (official) | STDIO | None (local) | File read/write in sandboxed paths |
| **Git MCP** (official) | STDIO | None (local) | Git operations |
| **PostgreSQL MCP** | STDIO | Connection string | Database credentials in env vars |

**Configuration Example (STDIO)**:
```json
{
  "mcpServers": {
    "filesystem": {
      "type": "STDIO",
      "command": "uvx",
      "args": ["mcp-server-filesystem", "--allowed-dir", "/workspace"]
    }
  }
}
```

### 2.6 Streamable HTTP Transport (Standard for Remote)

| Server | Transport | Auth Method | Key Features |
|--------|-----------|-------------|--------------|
| **MCP Playground** (`chrisleekr/mcp-server-playground`) | Streamable HTTP | OAuth Proxy (Auth0) | 3rd party authorization server support |
| **MetaMCP** | Streamable HTTP | OAuth 2.1 / API Key | Multiple auth methods per endpoint |

### 2.7 Environment Variable Authentication

| Server | Transport | Auth Method | Key Features |
|--------|-----------|-------------|--------------|
| **Slack MCP** (official) | STDIO | `SLACK_BOT_TOKEN` env | OAuth token passed via environment |
| **AWS MCP** | STDIO | `AWS_*` env vars | Standard AWS credential chain |

**Configuration Example (Env Vars)**:
```json
{
  "mcpServers": {
    "slack": {
      "type": "STDIO",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
        "SLACK_TEAM_ID": "${SLACK_TEAM_ID}"
      }
    }
  }
}
```

---

## 3. Current AgentPod MCP Architecture

AgentPod already has a comprehensive MCP implementation in `tauri-plugin-mcp/`:

### Existing Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Rust Plugin** | `tauri-plugin-mcp/src/` | Socket server, command routing |
| **TS MCP Server** | `tauri-plugin-mcp/mcp-server-ts/` | STDIO bridge, tool implementations |
| **Transport** | IPC (Unix socket) or TCP | Dual-mode socket support |
| **Tools** | Screenshot, JS execution, window control, etc. | Desktop automation |

### Current Limitations

1. **No multi-server aggregation** - Only single MCP server per connection
2. **No auth for external servers** - Socket permissions only
3. **Local only** - No remote MCP server support
4. **No server registry** - Static configuration

---

## 4. Integration Strategy

### Option A: Self-Hosted MetaMCP (Recommended)

Deploy MetaMCP alongside AgentPod infrastructure:

```
┌──────────────────────────────────────────────────────────────┐
│                    AgentPod Infrastructure                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │  Frontend   │  │ Management  │  │     MetaMCP         │   │
│  │   (Tauri)   │  │    API      │  │   (Docker)          │   │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘   │
│         │                │                     │              │
│         └────────────────┼─────────────────────┘              │
│                          ▼                                    │
│                   ┌─────────────┐                             │
│                   │  Database   │                             │
│                   │ (PostgreSQL)│                             │
│                   └─────────────┘                             │
└──────────────────────────────────────────────────────────────┘
```

**Pros**:
- Full control over MCP server composition
- Single unified endpoint for all MCP tools
- Built-in auth (API keys, OAuth, OIDC)
- Middleware support for logging, filtering
- Admin UI for server management

**Cons**:
- Additional container to manage
- Memory requirements (2-4GB)

### Option B: Embedded MCP Aggregation

Build lightweight aggregation layer in AgentPod's Management API:

**Pros**:
- No additional infrastructure
- Tighter integration with existing auth

**Cons**:
- More development effort
- Need to implement aggregation logic

### Recommendation: **Option A** for faster time-to-market, with Option B as future optimization.

---

## 5. Implementation Plan

### Phase 1: Infrastructure Setup (Week 1)

**Objective**: Deploy MetaMCP alongside AgentPod

#### Tasks:

1. **Add MetaMCP to docker-compose**
   ```yaml
   # docker-compose.yml addition
   metamcp:
     image: ghcr.io/metatool-ai/metamcp:latest
     ports:
       - "12008:12008"
     environment:
       - DATABASE_URL=postgresql://postgres:password@db:5432/metamcp
       - APP_URL=http://localhost:12008
       - BETTER_AUTH_SECRET=${METAMCP_AUTH_SECRET}
     depends_on:
       - db
     volumes:
       - metamcp_data:/app/data
   ```

2. **Create MetaMCP database schema**
   - Add `metamcp_*` tables or separate database

3. **Configure environment variables**
   - `METAMCP_URL`
   - `METAMCP_API_KEY`
   - `METAMCP_ADMIN_TOKEN`

#### Deliverables:
- [ ] MetaMCP container running in dev environment
- [ ] Database migrations for MetaMCP
- [ ] Environment configuration

---

### Phase 2: Server Registry (Week 2)

**Objective**: Enable adding/managing MCP servers through AgentPod

#### Tasks:

1. **Create MCP Server Registry API**
   ```typescript
   // apps/api/src/routes/mcp-servers.ts
   interface McpServerConfig {
     id: string;
     name: string;
     type: 'STDIO' | 'SSE' | 'STREAMABLE_HTTP';
     command?: string;
     args?: string[];
     url?: string;
     auth: {
       type: 'none' | 'api_key' | 'bearer' | 'oauth';
       config: Record<string, unknown>;
     };
     environment?: Record<string, string>;
     enabled: boolean;
   }
   ```

2. **Integrate with MetaMCP API**
   - Create/update/delete servers via MetaMCP REST API
   - Sync server configurations

3. **Build UI for server management**
   - Server list view
   - Add/edit server form
   - Connection status indicators

#### Deliverables:
- [ ] MCP Server CRUD API
- [ ] MetaMCP API integration
- [ ] Server management UI

---

### Phase 3: Authentication Strategies (Week 3)

**Objective**: Support multiple auth types for MCP servers

#### Tasks:

1. **Implement Auth Handler Factory**
   ```typescript
   // packages/types/src/mcp-auth.ts
   export type McpAuthType = 
     | 'none'
     | 'api_key'      // Environment variable
     | 'bearer_token' // Authorization header
     | 'oauth2'       // OAuth 2.1 flow
     | 'env_vars';    // Multiple env vars
   
   export interface McpAuthConfig {
     type: McpAuthType;
     apiKey?: string;
     bearerToken?: string;
     oauth?: {
       clientId: string;
       clientSecret?: string;
       scope?: string;
       authorizationUrl: string;
       tokenUrl: string;
     };
     envVars?: Record<string, string>;
   }
   ```

2. **Secure credential storage**
   - Encrypt secrets at rest
   - Use environment variable references (`${VAR}`)

3. **OAuth flow integration**
   - Redirect-based OAuth for browser
   - Token refresh handling

#### Deliverables:
- [ ] Auth type definitions
- [ ] Secure credential storage
- [ ] OAuth flow integration

---

### Phase 4: Namespace & Endpoint Management (Week 4)

**Objective**: Allow users to create namespaces and endpoints

#### Tasks:

1. **Namespace Management**
   - Group servers into namespaces
   - Enable/disable individual tools
   - Apply middleware (logging, filtering)

2. **Endpoint Creation**
   - Generate MetaMCP endpoints
   - Configure auth per endpoint
   - Support multiple transports (SSE, HTTP, OpenAPI)

3. **OpenCode.json Integration**
   - Auto-generate MCP configuration
   - Inject into sandboxes via onboarding

#### Deliverables:
- [ ] Namespace CRUD API
- [ ] Endpoint management UI
- [ ] OpenCode.json generator

---

### Phase 5: Frontend Integration (Week 5)

**Objective**: Integrate MetaMCP into AgentPod frontend

#### Tasks:

1. **MCP Management Dashboard**
   - Server status overview
   - Tool catalog browser
   - Connection health monitoring

2. **Sandbox MCP Configuration**
   - Per-sandbox MCP server selection
   - Tool permissions
   - Credential injection

3. **Inspector Integration**
   - Embedded MCP inspector
   - Tool testing interface

#### Deliverables:
- [ ] MCP management dashboard
- [ ] Sandbox configuration UI
- [ ] Embedded inspector

---

### Phase 6: Production Hardening (Week 6)

**Objective**: Production-ready deployment

#### Tasks:

1. **Security audit**
   - Credential handling review
   - OAuth flow security
   - API key rotation

2. **Monitoring & Observability**
   - MCP call logging
   - Error tracking
   - Performance metrics

3. **Documentation**
   - User guide for MCP setup
   - API documentation
   - Troubleshooting guide

#### Deliverables:
- [ ] Security review complete
- [ ] Monitoring dashboards
- [ ] User documentation

---

## 6. Database Schema

```sql
-- MCP Server configurations
CREATE TABLE mcp_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(20) NOT NULL CHECK (type IN ('STDIO', 'SSE', 'STREAMABLE_HTTP')),
  
  -- STDIO fields
  command VARCHAR(255),
  args JSONB DEFAULT '[]',
  
  -- Remote fields
  url VARCHAR(512),
  
  -- Auth configuration
  auth_type VARCHAR(20) NOT NULL DEFAULT 'none',
  auth_config JSONB DEFAULT '{}',
  
  -- Environment variables (encrypted)
  environment JSONB DEFAULT '{}',
  
  -- MetaMCP sync
  metamcp_server_id VARCHAR(255),
  
  -- Flags
  enabled BOOLEAN DEFAULT true,
  is_public BOOLEAN DEFAULT false,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Namespaces
CREATE TABLE mcp_namespaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  
  -- MetaMCP sync
  metamcp_namespace_id VARCHAR(255),
  
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Server-Namespace association
CREATE TABLE mcp_namespace_servers (
  namespace_id UUID REFERENCES mcp_namespaces(id) ON DELETE CASCADE,
  server_id UUID REFERENCES mcp_servers(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT true,
  PRIMARY KEY (namespace_id, server_id)
);

-- Tool overrides per namespace
CREATE TABLE mcp_tool_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id UUID REFERENCES mcp_namespaces(id) ON DELETE CASCADE,
  server_id UUID REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name VARCHAR(255) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  override_name VARCHAR(255),
  override_description TEXT,
  annotations JSONB DEFAULT '{}',
  UNIQUE (namespace_id, server_id, tool_name)
);

-- Endpoints
CREATE TABLE mcp_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  namespace_id UUID REFERENCES mcp_namespaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL UNIQUE,
  
  -- Auth settings
  auth_enabled BOOLEAN DEFAULT true,
  auth_type VARCHAR(20) DEFAULT 'api_key',
  
  -- MetaMCP sync
  metamcp_endpoint_id VARCHAR(255),
  
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- API keys for endpoints
CREATE TABLE mcp_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  endpoint_id UUID REFERENCES mcp_endpoints(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  description TEXT,
  scopes JSONB DEFAULT '[]',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 7. API Design

### MCP Server API

```typescript
// GET /api/mcp/servers
// List user's MCP servers

// POST /api/mcp/servers
interface CreateMcpServerRequest {
  name: string;
  type: 'STDIO' | 'SSE' | 'STREAMABLE_HTTP';
  command?: string;
  args?: string[];
  url?: string;
  auth: McpAuthConfig;
  environment?: Record<string, string>;
}

// PUT /api/mcp/servers/:id
// Update server configuration

// DELETE /api/mcp/servers/:id
// Remove server

// POST /api/mcp/servers/:id/test
// Test server connection
```

### Namespace API

```typescript
// GET /api/mcp/namespaces
// List namespaces

// POST /api/mcp/namespaces
interface CreateNamespaceRequest {
  name: string;
  description?: string;
  serverIds: string[];
}

// PUT /api/mcp/namespaces/:id/servers
// Update servers in namespace

// GET /api/mcp/namespaces/:id/tools
// List all tools in namespace

// PUT /api/mcp/namespaces/:id/tools/:toolId
// Override tool settings
```

### Endpoint API

```typescript
// POST /api/mcp/endpoints
interface CreateEndpointRequest {
  name: string;
  namespaceId: string;
  authEnabled: boolean;
  authType: 'api_key' | 'oauth';
}

// GET /api/mcp/endpoints/:id/url
// Get endpoint URLs (SSE, HTTP, OpenAPI)

// POST /api/mcp/endpoints/:id/keys
// Generate API key for endpoint
```

---

## 8. Configuration Examples

### OpenCode.json with MetaMCP

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agentpod-unified": {
      "type": "remote",
      "url": "${METAMCP_ENDPOINT_URL}",
      "headers": {
        "Authorization": "Bearer ${METAMCP_API_KEY}"
      }
    }
  }
}
```

### Direct Server Configuration

```json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@anthropic/mcp-server-github"],
      "environment": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "type": "local", 
      "command": ["uvx", "mcp-server-filesystem", "--allowed-dir", "/workspace"]
    },
    "remote-api": {
      "type": "remote",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

---

## 9. Migration Path

### For Existing Users

1. **Phase 1**: MetaMCP runs alongside existing MCP config
2. **Phase 2**: Gradual migration to MetaMCP-managed servers
3. **Phase 3**: Full MetaMCP integration with legacy config support

### Backwards Compatibility

- Existing `opencode.json` MCP configurations continue to work
- Users can mix local MCP servers with MetaMCP endpoints
- No breaking changes to current sandbox behavior

---

## 10. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| MCP server connection success rate | >99% | Health checks |
| Time to add new MCP server | <2 min | User flow analytics |
| Tool discovery latency | <500ms | API metrics |
| OAuth flow completion rate | >95% | Auth analytics |

---

## 11. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MetaMCP downtime | No MCP access | Fallback to direct connections |
| Credential exposure | Security breach | Encrypt secrets, use vault |
| OAuth token expiry | Connection drops | Token refresh, re-auth flows |
| Cold start latency | Poor UX | Pre-warm connections, idle sessions |

---

## 12. Next Steps

1. [ ] Review and approve this plan
2. [ ] Set up development environment with MetaMCP
3. [ ] Create database migrations
4. [ ] Begin Phase 1 implementation
5. [ ] Weekly progress reviews

---

## Appendix A: Reference Implementations

- **MetaMCP**: https://github.com/metatool-ai/metamcp
- **MCP TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **Remote MCP with Auth**: https://github.com/coleam00/remote-mcp-server-with-auth
- **Official MCP Servers**: https://github.com/modelcontextprotocol/servers
- **Awesome MCP Servers**: https://github.com/wong2/awesome-mcp-servers

## Appendix B: MCP Transport Specifications

- **Transports**: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- **Authorization**: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
