# OAuth Client Support for AgentPod

> **Date**: January 2026  
> **Status**: Scoped - Ready for Implementation  
> **Priority**: High  
> **Depends On**: MetaMCP Integration (Complete)

## Executive Summary

This document outlines the implementation plan for OAuth client support in AgentPod, enabling seamless authentication with OAuth-protected MCP servers (like Groww MCP) through the MetaMCP integration.

---

## 1. Problem Statement

### Current State
- MetaMCP is integrated with AgentPod for unified MCP server management
- SSO sync (AgentPod → MetaMCP) is working
- MCP server sync is bidirectional
- **OAuth-protected MCP servers cannot be used** because:
  1. OAuth flow requires browser interaction on user's machine
  2. MetaMCP runs in Docker, callback URLs are unreachable from host browser
  3. `mcp-remote` workaround doesn't work inside containers

### Example: Groww MCP
```
Resource Server:        https://mcp.groww.in/
Authorization Server:   https://api.groww.in/
Authorization URL:      https://groww.in/oauth/authorize
Token URL:              https://api.groww.in/oauth2/v1/token
PKCE Support:           Yes (S256, plain)
```

When adding Groww MCP to MetaMCP:
- Server returns HTTP 401 with `www-authenticate` header
- Header points to `.well-known/oauth-protected-resource` (RFC 9728)
- OAuth discovery works, but callback can't reach containerized `mcp-remote`

---

## 2. Proposed Solution

Build OAuth client capability into AgentPod that:
1. Detects OAuth-protected servers (via RFC 9728 discovery)
2. Opens browser popup from AgentPod UI for user authorization
3. Receives callback and exchanges code for tokens
4. Stores tokens in AgentPod database
5. Syncs tokens to MetaMCP via existing trigger mechanism
6. Agents use tokens automatically through MetaMCP

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          OAuth Flow Architecture                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌────────────┐ │
│  │  AgentPod   │     │  AgentPod   │     │   MetaMCP   │     │  External  │ │
│  │  Frontend   │────▶│     API     │────▶│  (synced)   │────▶│ MCP Server │ │
│  │  (Tauri)    │     │   (Hono)    │     │             │     │  (Groww)   │ │
│  └─────────────┘     └─────────────┘     └─────────────┘     └────────────┘ │
│        │                   │                   │                     │       │
│        │                   │                   │                     │       │
│        ▼                   ▼                   ▼                     ▼       │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         OAuth Flow Steps                                 ││
│  │                                                                         ││
│  │  1. User adds MCP server URL in AgentPod UI                            ││
│  │  2. AgentPod detects OAuth requirement (401 + discovery)               ││
│  │  3. UI shows "Authorize" button                                        ││
│  │  4. Click → Opens browser to authorization_endpoint                    ││
│  │  5. User logs in to external service (Groww)                           ││
│  │  6. Callback to AgentPod API with auth code                            ││
│  │  7. API exchanges code for tokens                                      ││
│  │  8. Tokens stored in AgentPod DB                                       ││
│  │  9. Tokens synced to MetaMCP oauth_sessions                            ││
│  │  10. Agents can now use the MCP server                                 ││
│  │                                                                         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Components to Build

### 4.1 Database Schema (AgentPod)

```sql
-- New table for OAuth sessions (mirrors MetaMCP's oauth_sessions)
CREATE TABLE mcp_oauth_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_ulid(),
  mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  
  -- OAuth Discovery (RFC 9728)
  resource_url TEXT,                    -- https://mcp.groww.in/
  authorization_server_url TEXT,        -- https://api.groww.in/
  
  -- Client Registration (Dynamic)
  client_id TEXT,
  client_secret TEXT,
  
  -- Tokens
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT DEFAULT 'Bearer',
  expires_at TIMESTAMP WITH TIME ZONE,
  scope TEXT,
  
  -- PKCE
  code_verifier TEXT,
  state TEXT,
  
  -- Metadata
  status TEXT DEFAULT 'pending',        -- pending, authorized, expired, error
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(mcp_server_id, user_id)
);

-- Index for lookups
CREATE INDEX idx_mcp_oauth_sessions_server ON mcp_oauth_sessions(mcp_server_id);
CREATE INDEX idx_mcp_oauth_sessions_user ON mcp_oauth_sessions(user_id);
CREATE INDEX idx_mcp_oauth_sessions_status ON mcp_oauth_sessions(status);
```

### 4.2 API Endpoints (AgentPod API - Hono)

```typescript
// apps/api/src/routes/mcp-oauth.ts

// GET /api/mcp/oauth/discover/:mcpServerId
// - Fetches .well-known/oauth-protected-resource
// - Fetches authorization server metadata
// - Returns OAuth config or null if not OAuth-protected

// POST /api/mcp/oauth/initiate/:mcpServerId
// - Generates PKCE code_verifier + code_challenge
// - Registers dynamic client if needed
// - Stores pending session
// - Returns authorization URL for browser redirect

// GET /api/mcp/oauth/callback
// - Receives code + state from OAuth provider
// - Exchanges code for tokens
// - Stores tokens in database
// - Returns success/error page (or redirects)

// POST /api/mcp/oauth/refresh/:mcpServerId
// - Refreshes expired tokens
// - Updates database

// DELETE /api/mcp/oauth/revoke/:mcpServerId
// - Revokes tokens
// - Clears database entry

// GET /api/mcp/oauth/status/:mcpServerId
// - Returns current OAuth status for a server
// - pending | authorized | expired | error
```

### 4.3 OAuth Service (AgentPod API)

```typescript
// apps/api/src/services/mcp-oauth.service.ts

interface OAuthService {
  // Discovery (RFC 9728)
  discoverOAuthMetadata(serverUrl: string): Promise<{
    resourceMetadata: OAuthProtectedResourceMetadata | null;
    authServerMetadata: OAuthAuthorizationServerMetadata | null;
  }>;
  
  // Flow
  initiateOAuthFlow(mcpServerId: string, userId: string): Promise<{
    authorizationUrl: string;
    state: string;
  }>;
  
  handleCallback(code: string, state: string): Promise<{
    success: boolean;
    mcpServerId: string;
    error?: string;
  }>;
  
  // Token Management
  getValidToken(mcpServerId: string, userId: string): Promise<string | null>;
  refreshTokenIfNeeded(mcpServerId: string, userId: string): Promise<boolean>;
  
  // Sync
  syncToMetaMCP(mcpServerId: string): Promise<void>;
}
```

### 4.4 Frontend Components (AgentPod Tauri App)

```svelte
<!-- MCP Server Card with OAuth Status -->
<!-- apps/frontend/src/lib/components/mcp-server-card.svelte -->
<script lang="ts">
  // Props
  export let server: McpServer;
  export let oauthStatus: OAuthStatus | null;
  
  // Show OAuth status badge
  // "Authorize" button if pending/none
  // "Re-authorize" if expired
  // "Connected" if valid
</script>

<!-- OAuth Authorization Modal -->
<!-- apps/frontend/src/lib/components/mcp-oauth-modal.svelte -->
<script lang="ts">
  // Opens external browser for OAuth
  // Shows "Waiting for authorization..."
  // Auto-closes on callback success
  // Polls /api/mcp/oauth/status for completion
</script>
```

### 4.5 Database Sync (AgentPod → MetaMCP)

Extend existing `sso-views.ts`:

```typescript
// apps/api/src/db/sso-views.ts

// Add sync for OAuth sessions
// AgentPod mcp_oauth_sessions → MetaMCP oauth_sessions

// Schema mapping:
// AgentPod                    → MetaMCP
// mcp_server_id (text)        → mcp_server_uuid (uuid via lookup)
// client_id, client_secret    → client_information (jsonb)
// access_token, refresh_token → tokens (jsonb)
// code_verifier               → code_verifier
```

---

## 5. Implementation Phases

### Phase 1: OAuth Discovery & Database (1-2 days)

**Tasks:**
- [ ] Create database migration for `mcp_oauth_sessions` table
- [ ] Add OAuth discovery endpoint (`GET /api/mcp/oauth/discover/:id`)
- [ ] Implement RFC 9728 discovery logic
- [ ] Add types to `@agentpod/types`

**Files to Create/Modify:**
- `apps/api/src/db/drizzle-migrations/00XX_mcp_oauth_sessions.sql`
- `apps/api/src/db/schema/mcp-oauth.ts`
- `apps/api/src/routes/mcp-oauth.ts`
- `apps/api/src/services/mcp-oauth.service.ts`
- `packages/types/src/mcp-oauth.ts`

### Phase 2: OAuth Flow Implementation (2-3 days)

**Tasks:**
- [ ] Implement PKCE generation (code_verifier, code_challenge)
- [ ] Implement dynamic client registration
- [ ] Create authorization URL generation endpoint
- [ ] Create callback handler endpoint
- [ ] Implement token exchange logic
- [ ] Add error handling and logging

**Files to Create/Modify:**
- `apps/api/src/services/mcp-oauth.service.ts` (extend)
- `apps/api/src/routes/mcp-oauth.ts` (extend)
- `apps/api/src/utils/pkce.ts`

### Phase 3: Token Storage & Refresh (1-2 days)

**Tasks:**
- [ ] Store tokens securely in database
- [ ] Implement token refresh logic
- [ ] Handle token expiration
- [ ] Add automatic refresh on API calls
- [ ] Implement token revocation

**Files to Create/Modify:**
- `apps/api/src/services/mcp-oauth.service.ts` (extend)
- `apps/api/src/routes/mcp-oauth.ts` (extend)

### Phase 4: MetaMCP Sync (1 day)

**Tasks:**
- [ ] Extend `sso-views.ts` for oauth_sessions sync
- [ ] Create trigger functions for AgentPod → MetaMCP sync
- [ ] Handle schema mapping (AgentPod → MetaMCP formats)
- [ ] Test bidirectional token availability

**Files to Create/Modify:**
- `apps/api/src/db/sso-views.ts` (extend)

### Phase 5: Frontend UI (2-3 days)

**Tasks:**
- [ ] Add OAuth status indicator to MCP server list
- [ ] Create "Authorize" button and flow
- [ ] Implement OAuth modal with progress indicator
- [ ] Add polling for authorization completion
- [ ] Handle success/error states
- [ ] Test end-to-end flow

**Files to Create/Modify:**
- `apps/frontend/src/lib/components/mcp-server-card.svelte`
- `apps/frontend/src/lib/components/mcp-oauth-modal.svelte`
- `apps/frontend/src/lib/api/mcp-oauth.ts`
- `apps/frontend/src/routes/settings/+page.svelte` (modify)

### Phase 6: Integration Testing (1 day)

**Tasks:**
- [ ] Test with Groww MCP
- [ ] Test token refresh flow
- [ ] Test error recovery
- [ ] Test sync to MetaMCP
- [ ] Verify agents can use authenticated servers

---

## 6. Technical Considerations

### 6.1 Callback URL Strategy

**Recommended: AgentPod API callback**

```
Callback URL: http://localhost:3001/api/mcp/oauth/callback
             (or https://your-domain.com/api/mcp/oauth/callback in production)
```

- AgentPod API receives callback directly
- Works in both dev and production
- No custom URL scheme required

**Alternative: Tauri Deep Link** (if API not accessible)
```
Callback URL: agentpod://oauth/callback
```
- Register custom URL scheme in Tauri
- Browser redirects to app directly
- More complex but works offline

### 6.2 Token Security

- Store tokens encrypted at rest (use existing encryption)
- Never log access tokens
- Use short-lived access tokens + refresh tokens
- Clear tokens on user logout
- Implement token rotation on refresh

### 6.3 Multi-user Support

- Tokens are per-user per-server
- Each user must authorize separately
- Tokens not shared between users
- Support team-shared servers (future)

### 6.4 Error Handling

| Error | Handling |
|-------|----------|
| OAuth discovery fails | Mark as non-OAuth server |
| Authorization denied | Show error, allow retry |
| Token exchange fails | Show error with details |
| Token refresh fails | Prompt re-authorization |
| Network errors | Retry with backoff |

---

## 7. Estimated Effort

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Discovery & DB | 1-2 days | None |
| Phase 2: OAuth Flow | 2-3 days | Phase 1 |
| Phase 3: Token Management | 1-2 days | Phase 2 |
| Phase 4: MetaMCP Sync | 1 day | Phase 3 |
| Phase 5: Frontend UI | 2-3 days | Phase 4 |
| Phase 6: Testing | 1 day | Phase 5 |
| **Total** | **8-12 days** | |

---

## 8. Success Criteria

| Criteria | Metric |
|----------|--------|
| OAuth discovery works | Detects OAuth servers automatically |
| Authorization flow completes | User can authorize via browser |
| Tokens stored securely | Encrypted in database |
| MetaMCP sync works | Tokens available in MetaMCP |
| Agents can use servers | Tools from OAuth servers accessible |
| Token refresh works | Automatic re-authentication |

---

## 9. Future Enhancements

1. **Team token sharing** - Share authorized servers with team members
2. **Token vault integration** - Use external secrets manager
3. **Multiple auth methods** - Support SAML, API keys alongside OAuth
4. **Token analytics** - Track usage, expiration alerts
5. **Headless OAuth** - For CI/CD and automation scenarios

---

## 10. References

- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/rfc9728/)
- [MCP Authorization Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
- [MetaMCP OAuth Documentation](https://docs.metamcp.com/en/troubleshooting/oauth-troubleshooting)
- [MCP TypeScript SDK Auth](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/auth.ts)

---

## 11. Appendix: Groww MCP OAuth Details (Reference)

Discovered via RFC 9728:

```json
// GET https://mcp.groww.in/.well-known/oauth-protected-resource
{
  "resource": "https://mcp.groww.in/",
  "authorization_servers": ["https://api.groww.in/"],
  "bearer_methods_supported": ["header"]
}

// GET https://api.groww.in/.well-known/oauth-authorization-server
{
  "issuer": "https://groww.in",
  "authorization_endpoint": "https://groww.in/oauth/authorize",
  "token_endpoint": "https://api.groww.in/oauth2/v1/token",
  "registration_endpoint": "https://api.groww.in/oauth2/v1/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["plain", "S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic"]
}
```
