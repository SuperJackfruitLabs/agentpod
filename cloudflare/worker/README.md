# AgentPod Sandbox Worker

> ## Dead as of 2026-08-12 — see [DEAD.md](./DEAD.md).
>
> This worker is not deployed and is not the Cloudflare substrate. The live one is
> [`cloudflare/worker-v2`](../worker-v2/). Nothing below is maintained: the route table is
> already wrong (`POST /execute` is really `POST /workflow/execute`, `GET /sandbox/:id/status`
> is really `GET /sandbox/:id`), the test inventory lists 5 of 17 files with one wrong count,
> and the closing "Kept (not OpenCode legacy)" section is the claim DEAD.md retracts.
> Left as a record rather than corrected — correcting a dead worker's docs is the work this
> repo is trying to stop doing.


Cloudflare Worker providing isolated sandbox environments for workflow execution using Cloudflare Containers and Durable Objects.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge                              │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐   │
│  │    Worker     │───▶│ Durable Object│───▶│   Container   │   │
│  │  (Router)     │    │   (Sandbox)   │    │  (Execution)  │   │
│  └───────────────┘    └───────────────┘    └───────────────┘   │
│         │                                          │            │
│         │              Status Updates              │            │
│         └──────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌───────────────┐
                    │  AgentPod API │
                    │ (Status Sync) │
                    └───────────────┘
```

## Features

- **Isolated Execution**: Each workflow runs in its own Cloudflare Container
- **Durable State**: Sandbox state persisted via Durable Objects with SQLite
- **R2 Storage**: Workspace files stored in R2 buckets
- **Real-time Updates**: Status updates sent to AgentPod API during execution
- **Visual Workflows**: Execute node-based workflows with various node types

## Supported Node Types

| Node Type | Description |
|-----------|-------------|
| `trigger` | Manual, scheduled, or webhook triggers |
| `http` | HTTP requests to external APIs |
| `code` | JavaScript code execution |
| `condition` | If/else branching logic |
| `switch` | Multi-path routing based on value |
| `loop` | Iterate over arrays |
| `merge` | Combine multiple branches |
| `ai` | AI model invocations (coming soon) |

## Setup

### Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Cloudflare account with Workers Paid plan (for Containers)

### Installation

```bash
cd cloudflare/worker
npm install
```

### Local Development

1. **Copy environment template:**
   ```bash
   cp .dev.vars.example .dev.vars
   ```

2. **Edit `.dev.vars` with your local values:**
   ```bash
   AGENTPOD_API_URL=http://localhost:3001
   AGENTPOD_API_TOKEN=your-local-api-token
   ```

   The `AGENTPOD_API_TOKEN` must match the `API_TOKEN` in your `apps/hub/.env` file.

3. **Start the local API:**
   ```bash
   cd apps/hub
   bun dev
   ```

4. **Start the worker:**
   ```bash
   npm run dev
   ```

5. **Test with remote resources (Durable Objects, R2):**
   ```bash
   npm run dev:remote
   ```

### Production Deployment

1. **Set production secrets:**
   ```bash
   # Set the API token (must match your production API's API_TOKEN)
   npm run secret:set AGENTPOD_API_TOKEN
   # Enter your token when prompted
   ```

2. **Verify secrets:**
   ```bash
   npm run secret:list
   ```

3. **Deploy:**
   ```bash
   npm run deploy
   ```

4. **View logs:**
   ```bash
   npm run tail
   ```

## Configuration

### wrangler.toml

The worker configuration is in `wrangler.toml`:

```toml
name = "agentpod-sandbox"
main = "src/index.ts"

# Durable Objects for sandbox state
[durable_objects]
bindings = [{ name = "Sandbox", class_name = "Sandbox" }]

# R2 bucket for workspace files
[[r2_buckets]]
binding = "WORKSPACE_BUCKET"
bucket_name = "agentpod-workspaces"

# Environment variables
[vars]
AGENTPOD_API_URL = "https://api.agentpod.app"
```

### Environments

| Environment | Command | API URL |
|-------------|---------|---------|
| Production | `npm run deploy` | `https://api.agentpod.app` |
| Development | `npm run deploy:dev` | `http://localhost:3001` |
| Local | `npm run dev` | From `.dev.vars` |

## API Endpoints

### Execute Workflow

```http
POST /execute
Content-Type: application/json

{
  "executionId": "exec_123",
  "workflowId": "wf_456",
  "definition": {
    "nodes": [...],
    "edges": [...]
  },
  "inputs": {
    "key": "value"
  }
}
```

### Get Sandbox Status

```http
GET /sandbox/:sandboxId/status
```

### Health Check

```http
GET /health
```

## Testing

```bash
# Run all tests
npm test

# Run tests once
npm run test:run

# Run with coverage
npm run test:coverage
```

### Test Coverage

- `executor.test.ts` - Workflow executor logic (16 tests)
- `nodes/trigger.test.ts` - Trigger node processing (10 tests)
- `nodes/condition.test.ts` - Condition/switch nodes (67 tests)
- `nodes/code.test.ts` - Merge/loop nodes (22 tests)
- `nodes/http.test.ts` - HTTP request handling (23 tests)

## Development Workflow

### Making Changes

1. Edit source files in `src/`
2. Run tests: `npm test`
3. Test locally: `npm run dev`
4. Deploy to dev: `npm run deploy:dev`
5. Verify with: `npm run tail:dev`
6. Deploy to production: `npm run deploy`

### Debugging

**View live logs:**
```bash
npm run tail
```

**Check deployment status:**
```bash
npx wrangler deployments list
```

**View worker metrics:**
Visit [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → agentpod-sandbox

## Troubleshooting

### "API not configured, skipping status update"

The worker can't reach the AgentPod API. Check:
1. `.dev.vars` has correct `AGENTPOD_API_URL`
2. Local API is running (`cd apps/hub && bun dev`)
3. API is accessible from where worker runs

### "Authentication failed"

The API token doesn't match. Verify:
1. `.dev.vars` `AGENTPOD_API_TOKEN` matches `apps/hub/.env` `API_TOKEN`
2. For production: `npm run secret:list` shows the secret is set

### Container startup issues

Cloudflare Containers require Workers Paid plan. Check:
1. Your Cloudflare account has Workers Paid
2. Container image builds successfully (`./Dockerfile`)

## Related Documentation

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Containers](https://developers.cloudflare.com/workers/containers/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [R2 Storage](https://developers.cloudflare.com/r2/)

---

## AgentPod role

This worker is the **Cloudflare provisioning target** for AgentPod's fleet console.
The hub's P4 CF provisioner (`apps/hub/src/services/provisioner/cloudflare.ts`) posts
to it via `CLOUDFLARE_WORKER_URL` to create node-agent sandboxes; the worker calls
back to the hub's `/api/v2/cloudflare` webhook. Kept (not OpenCode legacy). CF
provisioning is gated by `ENABLE_CLOUDFLARE_SANDBOXES` and is currently live-unverified.
