# Multi-Agent Ecosystem Research

> **Version:** 1.0.0  
> **Last Updated:** January 5, 2026  
> **Status:** Active Research

---

## Overview

This research documents the rapidly evolving multi-agent AI ecosystem, covering protocols, frameworks, governance, and infrastructure. The goal is to inform AgentPod's architecture decisions and ensure interoperability with industry standards.

---

## Executive Summary

The multi-agent ecosystem has matured significantly in 2024-2025:

1. **Protocol Standardization** - MCP, A2A, AG-UI creating interoperability layers
2. **Linux Foundation Governance** - AAIF providing neutral stewardship
3. **Enterprise Adoption** - Major cloud providers shipping production-ready frameworks
4. **Open-Source Maturity** - LangGraph, CrewAI, AutoGen reaching production quality

---

## The Protocol Stack

```
┌─────────────────────────────────────────────────────────────┐
│                         FRONTEND                            │
│                         (AG-UI)                             │
│              Streaming, UI events, human-in-the-loop        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│    ┌─────────────┐        A2A         ┌─────────────┐      │
│    │   Agent A   │◄──────────────────►│   Agent B   │      │
│    │             │   Discovery,       │             │      │
│    │             │   Delegation,      │             │      │
│    │             │   Collaboration    │             │      │
│    └──────┬──────┘                    └──────┬──────┘      │
│           │                                  │              │
│           │ MCP                               │ MCP         │
│           │ Tools, Resources,                │              │
│           │ Authentication                   │              │
│           ▼                                  ▼              │
│    ┌─────────────┐                    ┌─────────────┐      │
│    │   Tools     │                    │   Tools     │      │
│    │   (APIs)    │                    │   (Data)    │      │
│    └─────────────┘                    └─────────────┘      │
│                                                             │
│    ┌─────────────────────────────────────────────────────┐ │
│    │                    AGENTS.md                         │ │
│    │              (Per-project instructions)              │ │
│    └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Documentation Index

### [Protocols](./protocols/)

Communication standards for multi-agent systems.

| Protocol | Purpose | Status | Documentation |
|----------|---------|--------|---------------|
| **MCP** | Agent ↔ Tools/Data | ✅ Production | [MCP](./protocols/mcp.md) |
| **A2A** | Agent ↔ Agent | ✅ Production | [A2A](./protocols/a2a.md) |
| **AG-UI** | Agent ↔ Frontend | ✅ Active | [AG-UI](./protocols/ag-ui.md) |
| **AGENTS.md** | Agent Instructions | ✅ Active | [AGENTS.md](./protocols/agents-md.md) |
| **Agent Protocol** | REST API Standard | ✅ Active | [Agent Protocol](./protocols/agent-protocol.md) |

### [Governance](./governance/)

Industry governance and standards bodies.

| Organization | Purpose | Documentation |
|--------------|---------|---------------|
| **AAIF** | Linux Foundation governance for agent standards | [AAIF](./governance/aaif.md) |

### [Frameworks](./frameworks/)

Multi-agent development frameworks.

| Framework | Provider | Type | Documentation |
|-----------|----------|------|---------------|
| **Cloudflare Agents** | Cloudflare | Full-stack SDK | [Cloudflare](./frameworks/cloudflare-agents.md) |
| **AWS Agents** | Amazon | Managed + Open Source | [AWS](./frameworks/aws-agents.md) |
| **Google ADK** | Google | Open Source | [Google ADK](./frameworks/google-adk.md) |
| **Microsoft Agents** | Microsoft | Open Source | [Microsoft](./frameworks/microsoft-agents.md) |
| **Vercel AI SDK** | Vercel | SDK | [Vercel](./frameworks/vercel-ai-sdk.md) |
| **Open Source** | Community | Various | [Open Source](./frameworks/open-source.md) |

### [Infrastructure](./infrastructure/)

Supporting infrastructure for agent systems.

| Component | Purpose | Documentation |
|-----------|---------|---------------|
| **Docker MCP** | MCP server catalog and containerization | [Docker MCP](./infrastructure/docker-mcp.md) |
| **Durable Workflows** | Long-running agent execution | _(never written — the link here pointed at a file that has never existed)_ |

---

## Quick Comparison Matrix

### Protocol Comparison

| Protocol | Layer | Transport | Originator | Governance |
|----------|-------|-----------|------------|------------|
| MCP | Tools | JSON-RPC/HTTP/stdio | Anthropic | AAIF |
| A2A | Agent-to-Agent | HTTP + JSON | Google | LF |
| AG-UI | Frontend | Event streaming | CopilotKit | Community |
| AGENTS.md | Instructions | File-based | OpenAI | AAIF |
| Agent Protocol | REST API | HTTP REST | E2B | AIEF |

### Framework Comparison

| Framework | Language | Multi-Agent | MCP | A2A | Production Ready |
|-----------|----------|-------------|-----|-----|------------------|
| Cloudflare Agents | TS/JS | ✅ | ✅ | ❌ | ✅ |
| AWS Bedrock Agents | Any | ✅ | ✅ | ❌ | ✅ |
| Strands Agents | Python/TS | ✅ | ✅ | ✅ | ✅ |
| Google ADK | Multi | ✅ | ✅ | ✅ | ✅ |
| Microsoft Agent Framework | C#/Python | ✅ | ✅ | ❌ | ✅ |
| Vercel AI SDK | TS | ❌ | ✅ | ❌ | ✅ |
| LangGraph | Python/TS | ✅ | ✅ | ❌ | ✅ |
| AutoGen (AG2) | Python | ✅ | ✅ | ❌ | ✅ |
| CrewAI | Python | ✅ | ✅ | ❌ | ✅ |

---

## Key Insights

### 1. MCP is the De Facto Standard for Tool Integration

Every major framework now supports MCP. With 240+ servers in Docker Hub and backing from all major players (Anthropic, Google, Microsoft, AWS, Cloudflare), MCP has won the tool integration layer.

### 2. A2A is Emerging for Agent-to-Agent Communication

Google's A2A protocol is gaining traction for multi-agent scenarios. Strands and Google ADK have native support; expect broader adoption in 2026.

### 3. AAIF Provides Neutral Governance

The Linux Foundation's AAIF prevents vendor lock-in and ensures protocols evolve for the benefit of all. Key projects (MCP, goose, AGENTS.md) now have neutral governance.

### 4. Enterprise Frameworks are Framework-Agnostic

AWS AgentCore, Google ADK, and Microsoft's offerings are designed to work with any framework. Infrastructure is decoupling from application logic.

### 5. Open Source is Production Ready

LangGraph, CrewAI, and AutoGen/AG2 are being used in production by major companies. The "build vs. buy" calculus has shifted toward open source.

---

## AgentPod Recommendations

See [Recommendations](./recommendations.md) for AgentPod-specific guidance on protocol adoption and framework selection.

---

## Research Methodology

This research was compiled from:
- Official documentation and specifications
- GitHub repositories and release notes
- Conference talks and blog posts
- Direct API exploration and testing

**Last comprehensive update:** January 5, 2026

---

## Contributing

To update this research:
1. Create a PR with updates to relevant documents
2. Include source links for any new information
3. Update the "Last Updated" date in affected files

---

*Part of AgentPod Documentation*
