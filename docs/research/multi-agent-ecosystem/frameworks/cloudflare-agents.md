# Cloudflare Agents SDK

> **Version:** 1.0.0  
> **Last Updated:** January 5, 2026  
> **Status:** Production

---

## Overview

| Attribute | Value |
|-----------|-------|
| **Provider** | Cloudflare |
| **Type** | Full-stack SDK + Runtime |
| **Language** | TypeScript / JavaScript |
| **Documentation** | https://developers.cloudflare.com/agents/ |
| **GitHub** | https://github.com/cloudflare/agents |

---

## What is Cloudflare Agents?

Cloudflare Agents SDK is a framework for building AI agents that run on Cloudflare's global edge network. Unlike traditional server-based agents, Cloudflare Agents are stateful, long-running processes backed by Durable Objects.

### Key Differentiators

1. **Edge-Native** - Agents run on Cloudflare's edge, close to users
2. **Stateful by Default** - Built-in state management via Durable Objects
3. **WebSocket Support** - Real-time bidirectional communication
4. **Integrated Platform** - Access to Workers AI, Vectorize, D1, R2

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Application                     │
│                  (Browser, Mobile, Server)                  │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ WebSocket / HTTP
                           │
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   Cloudflare Worker                  │   │
│  │              (Entry Point / Router)                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │               Durable Object (Agent)                 │   │
│  │                                                      │   │
│  │  ┌────────────────┐  ┌────────────────┐            │   │
│  │  │  Agent State   │  │  SQLite DB     │            │   │
│  │  │  (this.state)  │  │  (this.sql)    │            │   │
│  │  └────────────────┘  └────────────────┘            │   │
│  │                                                      │   │
│  │  ┌────────────────┐  ┌────────────────┐            │   │
│  │  │   Scheduler    │  │   WebSocket    │            │   │
│  │  │ (this.schedule)│  │  Connections   │            │   │
│  │  └────────────────┘  └────────────────┘            │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│           ┌───────────────┼───────────────┐                │
│           ▼               ▼               ▼                │
│    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│    │Workers AI│    │ Vectorize│    │   D1/R2  │          │
│    └──────────┘    └──────────┘    └──────────┘          │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### Agent Class

The `Agent` class is the foundation of Cloudflare Agents:

```typescript
import { Agent, AgentNamespace } from "agents";

export class MyAgent extends Agent {
  // Called when agent starts
  async onStart() {
    console.log("Agent started");
  }

  // Handle incoming messages
  async onMessage(message: string) {
    // Process message and respond
    return `Received: ${message}`;
  }

  // Handle HTTP requests
  async onRequest(request: Request) {
    return new Response("Hello from agent!");
  }
}
```

### State Management

Agents have built-in state that persists across requests:

```typescript
export class StatefulAgent extends Agent {
  // Set state (automatically persisted)
  async incrementCounter() {
    const current = this.state.counter || 0;
    this.setState({ counter: current + 1 });
    return this.state.counter;
  }

  // SQL database access
  async saveItem(item: Item) {
    await this.sql`
      INSERT INTO items (id, name, data)
      VALUES (${item.id}, ${item.name}, ${item.data})
    `;
  }

  async getItems() {
    return await this.sql`SELECT * FROM items`;
  }
}
```

### Scheduling

Agents can schedule future tasks:

```typescript
export class ScheduledAgent extends Agent {
  async onStart() {
    // Schedule a task for 1 hour from now
    this.schedule(Date.now() + 60 * 60 * 1000, "hourly-check", {
      type: "maintenance"
    });
  }

  // Called when scheduled task triggers
  async onScheduled(id: string, payload: any) {
    if (payload.type === "maintenance") {
      await this.performMaintenance();
    }
  }
}
```

### WebSocket Communication

Real-time bidirectional communication:

```typescript
export class ChatAgent extends Agent {
  connections = new Set<WebSocket>();

  async onConnect(ws: WebSocket) {
    this.connections.add(ws);
    ws.send(JSON.stringify({ type: "connected" }));
  }

  async onMessage(ws: WebSocket, message: string) {
    const data = JSON.parse(message);
    
    // Broadcast to all connected clients
    for (const conn of this.connections) {
      conn.send(JSON.stringify({
        type: "message",
        from: data.userId,
        content: data.content
      }));
    }
  }

  async onClose(ws: WebSocket) {
    this.connections.delete(ws);
  }
}
```

---

## Platform Integration

### Workers AI

Access LLMs directly from agents:

```typescript
export class AIAgent extends Agent {
  async chat(prompt: string) {
    const response = await this.env.AI.run("@cf/meta/llama-2-7b-chat-int8", {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt }
      ]
    });
    
    return response.response;
  }
}
```

### Vectorize

Vector search for RAG:

```typescript
export class RAGAgent extends Agent {
  async search(query: string) {
    // Generate embedding
    const embedding = await this.env.AI.run(
      "@cf/baai/bge-base-en-v1.5",
      { text: query }
    );
    
    // Search vector database
    const results = await this.env.VECTORIZE.query(embedding.data[0], {
      topK: 5
    });
    
    return results.matches;
  }
}
```

### AI Gateway

Route AI requests through AI Gateway for observability:

```typescript
export class GatewayAgent extends Agent {
  async chat(prompt: string) {
    const response = await fetch(
      "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: prompt }]
        })
      }
    );
    
    return response.json();
  }
}
```

---

## Workflows Integration

For long-running tasks, integrate with Cloudflare Workflows:

```typescript
import { Workflow, WorkflowStep } from "cloudflare:workers";

export class AgentWorkflow extends Workflow {
  async run(event: WorkflowEvent) {
    // Step 1: Analyze request
    const analysis = await this.step("analyze", async () => {
      return await analyzeRequest(event.payload);
    });

    // Step 2: Execute agent tasks
    const results = await this.step("execute", async () => {
      const agent = await this.env.AGENT.get(event.agentId);
      return await agent.executeTask(analysis);
    });

    // Step 3: Notify completion
    await this.step("notify", async () => {
      await notifyUser(event.userId, results);
    });

    return results;
  }
}
```

---

## React Integration

Cloudflare Agents includes React hooks:

```tsx
import { useAgent } from "@cloudflare/agents-react";

function ChatApp() {
  const { 
    messages, 
    send, 
    isConnected,
    state 
  } = useAgent({
    agentUrl: "/agent",
    onMessage: (msg) => console.log("Received:", msg)
  });

  return (
    <div>
      <div className="messages">
        {messages.map((msg, i) => (
          <div key={i}>{msg.content}</div>
        ))}
      </div>
      <input
        onKeyPress={(e) => {
          if (e.key === "Enter") {
            send(e.currentTarget.value);
          }
        }}
      />
    </div>
  );
}
```

---

## Configuration

### wrangler.jsonc

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-agent",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01",
  
  "durable_objects": {
    "bindings": [
      {
        "name": "AGENT",
        "class_name": "MyAgent"
      }
    ]
  },
  
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyAgent"]
    }
  ],
  
  "ai": {
    "binding": "AI"
  },
  
  "vectorize": {
    "bindings": [
      {
        "name": "VECTORIZE",
        "index_name": "my-index"
      }
    ]
  }
}
```

---

## Deployment

```bash
# Create project
npm create cloudflare@latest my-agent -- --template=cloudflare/agents-starter

# Development
npm run dev

# Deploy
npx wrangler deploy
```

---

## Use Cases

### 1. Conversational AI

Real-time chat with persistent memory:

```typescript
export class ConversationAgent extends Agent {
  async chat(message: string) {
    // Load conversation history
    const history = await this.sql`
      SELECT * FROM messages ORDER BY created_at DESC LIMIT 10
    `;
    
    // Generate response
    const response = await this.env.AI.run("@cf/meta/llama-2-7b-chat-int8", {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: message }
      ]
    });
    
    // Save to history
    await this.sql`
      INSERT INTO messages (role, content) VALUES ('user', ${message})
    `;
    await this.sql`
      INSERT INTO messages (role, content) VALUES ('assistant', ${response.response})
    `;
    
    return response.response;
  }
}
```

### 2. Task Automation

Scheduled tasks with human-in-the-loop:

```typescript
export class AutomationAgent extends Agent {
  async onScheduled(id: string, task: any) {
    // Execute automated task
    const result = await this.executeTask(task);
    
    // If uncertain, request human approval
    if (result.confidence < 0.8) {
      await this.requestApproval(result);
    } else {
      await this.completeTask(result);
    }
  }
  
  async onApproval(taskId: string, approved: boolean) {
    if (approved) {
      await this.completeTask(taskId);
    } else {
      await this.cancelTask(taskId);
    }
  }
}
```

### 3. Multi-User Collaboration

Shared agent state across users:

```typescript
export class CollaborationAgent extends Agent {
  async join(userId: string) {
    const participants = this.state.participants || [];
    this.setState({
      participants: [...participants, userId]
    });
    
    // Notify all participants
    for (const ws of this.connections) {
      ws.send(JSON.stringify({
        type: "user_joined",
        userId
      }));
    }
  }
}
```

---

## Limitations

| Limitation | Details |
|------------|---------|
| **Edge Only** | Cannot self-host |
| **JavaScript/TypeScript** | No Python support |
| **Cloudflare Lock-in** | Uses Cloudflare-specific APIs |
| **Durable Object Limits** | 128KB state, 128MB SQLite |
| **No A2A Protocol** | No native agent-to-agent support |

---

## Pricing

| Component | Pricing |
|-----------|---------|
| Workers | First 10M requests free, then $0.30/M |
| Durable Objects | $0.15/M requests + storage |
| Workers AI | Usage-based per model |
| Vectorize | $0.01/M vectors queried |
| AI Gateway | Free for observability |

---

## AgentPod Integration

### Relevance

Cloudflare Agents is relevant for AgentPod because:
1. AgentPod already uses Cloudflare Workflows
2. Edge deployment could benefit latency-sensitive features
3. Durable Objects pattern aligns with agent state needs

### Potential Integration

```typescript
// AgentPod could use Cloudflare Agents for:
// 1. Edge-based chat agents (low latency)
// 2. Workflow orchestration
// 3. Real-time collaboration features

export class AgentPodAgent extends Agent {
  // Bridge to sandbox containers
  async delegateToSandbox(sandboxId: string, task: any) {
    const response = await fetch(
      `https://api.agentpod.dev/sandboxes/${sandboxId}/tasks`,
      {
        method: "POST",
        body: JSON.stringify(task)
      }
    );
    return response.json();
  }
}
```

---

## Resources

- **Documentation:** https://developers.cloudflare.com/agents/
- **GitHub:** https://github.com/cloudflare/agents
- **Starter Template:** https://github.com/cloudflare/agents-starter
- **Examples:** https://developers.cloudflare.com/agents/examples/
- **Discord:** Cloudflare Developers Discord

---

## Related Documentation

- [AWS Agents](./aws-agents.md) - AWS agent offerings
- [Docker MCP](../infrastructure/docker-mcp.md) - MCP server catalog
- [Cloudflare Integration](../../../archive/architecture/cloudflare-integration.md) - AgentPod's **pre-pivot** Cloudflare setup (archived; today's is `cloudflare/worker-v2/`)

---

*Part of AgentPod Multi-Agent Ecosystem Research*
