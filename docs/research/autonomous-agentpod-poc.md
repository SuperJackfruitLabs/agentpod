# Autonomous AgentPod POC: Self-Running Platform

> **Status:** Implementation Plan  
> **Created:** December 2025  
> **Goal:** Use AgentPod to autonomously operate AgentPod itself  
> **Timeline:** 2 weeks

---

## Executive Summary

We will deploy 5 AI agents that autonomously handle AgentPod's daily operations:

| Agent | Role | Frequency | Status |
|-------|------|-----------|--------|
| **Olivia** | DevOps Monitor | Hourly | Ready Today |
| **Sophie** | Support Bot | On-demand (webhooks) | 80% Ready |
| **Pete** | Product Analyst | Weekly | Ready Today |
| **Morgan** | Content Creator | Weekly | 80% Ready |
| **Kai** | Code Contributor | On-demand | 90% Ready |

**Expected Outcome:** Save 10-15 hours/week of manual work while running AgentPod operations 24/7.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AGENTPOD AUTONOMOUS OPERATIONS                        │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                     TRIGGER SOURCES                                  ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    ││
│  │  │  GitHub  │  │ Discord  │  │  Cron    │  │ Cloudflare       │    ││
│  │  │ Webhooks │  │   Bot    │  │ Schedule │  │ Analytics API    │    ││
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘    ││
│  └───────┼─────────────┼─────────────┼─────────────────┼───────────────┘│
│          │             │             │                 │                 │
│          ▼             ▼             ▼                 ▼                 │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                  CLOUDFLARE WORKFLOWS ENGINE                         ││
│  │                                                                      ││
│  │   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ││
│  │   │ OLIVIA  │  │ SOPHIE  │  │  PETE   │  │ MORGAN  │  │   KAI   │  ││
│  │   │ DevOps  │  │ Support │  │ Product │  │ Content │  │  Code   │  ││
│  │   │ Monitor │  │   Bot   │  │ Analyst │  │ Creator │  │ Contrib │  ││
│  │   └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  ││
│  └────────┼────────────┼────────────┼────────────┼────────────┼────────┘│
│           │            │            │            │            │          │
│           ▼            ▼            ▼            ▼            ▼          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                       OUTPUT ACTIONS                                 ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            ││
│  │  │  GitHub  │  │ Discord  │  │  Email   │  │  Blog    │            ││
│  │  │  Issues  │  │  Alerts  │  │ Reports  │  │  Posts   │            ││
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘            ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Required Integrations

### API Keys & Tokens Needed

| Service | Purpose | How to Get |
|---------|---------|------------|
| **GitHub Personal Access Token** | Read issues, create PRs, manage labels | GitHub Settings → Developer → PAT (classic) |
| **Discord Webhook URL** | Send alerts to #ops channel | Server Settings → Integrations → Webhooks |
| **Discord Bot Token** | Read messages from #support | Discord Developer Portal → Bot |
| **OpenAI API Key** | AI chat completions | platform.openai.com |
| **Anthropic API Key** | Claude for content generation | console.anthropic.com |
| **Resend API Key** | Email sending | resend.com |
| **Twitter API Keys** | Social posting (optional) | developer.twitter.com |

### Environment Variables

Add to `cloudflare/worker/.dev.vars` (local) and Cloudflare secrets (production):

```bash
# GitHub Integration
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_REPO=rakeshgangwar/agentpod
GITHUB_OWNER=rakeshgangwar

# Discord Integration
DISCORD_WEBHOOK_OPS=https://discord.com/api/webhooks/xxx/yyy
DISCORD_WEBHOOK_SUPPORT=https://discord.com/api/webhooks/xxx/yyy
DISCORD_BOT_TOKEN=MTIxxxxxxxxxxxxxxxxxxxxxxxxxxx

# AI Providers
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Email (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
ALERT_EMAIL=your-email@example.com

# Cloudflare (already configured)
# AGENTPOD_API_URL=https://api.agentpod.app
# AGENTPOD_API_TOKEN=xxx

# Optional: Social Media
TWITTER_API_KEY=xxx
TWITTER_API_SECRET=xxx
TWITTER_ACCESS_TOKEN=xxx
TWITTER_ACCESS_SECRET=xxx
```

---

## Agent #1: Olivia (DevOps Monitor)

### Purpose
Monitor AgentPod infrastructure health and alert on issues.

### Trigger
- **Schedule**: Every hour (`0 * * * *`)
- **On-demand**: Manual trigger for immediate health check

### Data Sources
1. **Cloudflare Analytics API** - Worker errors, request counts
2. **GitHub Actions API** - CI/CD status
3. **PostgreSQL** - Database health (via Management API)
4. **Docker** - Container status (via Management API)

### Workflow Definition

```json
{
  "id": "wf_olivia_devops_monitor",
  "name": "Olivia - DevOps Health Monitor",
  "description": "Hourly infrastructure health check with automatic alerting",
  "active": true,
  "nodes": [
    {
      "id": "trigger",
      "name": "Hourly Health Check",
      "type": "schedule-trigger",
      "position": [100, 200],
      "parameters": {
        "cron": "0 * * * *",
        "timezone": "UTC"
      }
    },
    {
      "id": "check_worker_errors",
      "name": "Check Cloudflare Worker Errors",
      "type": "http-request",
      "position": [300, 100],
      "parameters": {
        "method": "GET",
        "url": "https://api.cloudflare.com/client/v4/accounts/{{env.CF_ACCOUNT_ID}}/workers/scripts/agentpod-sandbox/analytics",
        "headers": {
          "Authorization": "Bearer {{env.CF_API_TOKEN}}",
          "Content-Type": "application/json"
        }
      }
    },
    {
      "id": "check_api_health",
      "name": "Check Management API Health",
      "type": "http-request",
      "position": [300, 200],
      "parameters": {
        "method": "GET",
        "url": "{{env.AGENTPOD_API_URL}}/health",
        "headers": {
          "Authorization": "Bearer {{env.AGENTPOD_API_TOKEN}}"
        }
      }
    },
    {
      "id": "check_github_actions",
      "name": "Check GitHub Actions Status",
      "type": "http-request",
      "position": [300, 300],
      "parameters": {
        "method": "GET",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/actions/runs?per_page=5",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}",
          "Accept": "application/vnd.github.v3+json"
        }
      }
    },
    {
      "id": "aggregate_health",
      "name": "Aggregate Health Data",
      "type": "aggregate",
      "position": [500, 200],
      "parameters": {
        "operation": "merge",
        "inputs": ["worker_errors", "api_health", "github_actions"]
      }
    },
    {
      "id": "analyze_health",
      "name": "AI Analysis of Health Status",
      "type": "ai-chat",
      "position": [700, 200],
      "parameters": {
        "model": "gpt-4o-mini",
        "systemPrompt": "You are Olivia, a DevOps monitoring agent. Analyze infrastructure health data and provide a concise status report. Flag any critical issues that need immediate attention.",
        "userPrompt": "Analyze this infrastructure health data:\n\nWorker Errors: {{steps.check_worker_errors.data}}\nAPI Health: {{steps.check_api_health.data}}\nGitHub Actions: {{steps.check_github_actions.data}}\n\nProvide:\n1. Overall status (HEALTHY/WARNING/CRITICAL)\n2. Key metrics summary\n3. Any issues requiring attention\n4. Recommended actions",
        "temperature": 0.3
      }
    },
    {
      "id": "check_critical",
      "name": "Check for Critical Issues",
      "type": "condition",
      "position": [900, 200],
      "parameters": {
        "conditions": [
          {
            "field": "{{steps.analyze_health.data.content}}",
            "operator": "contains",
            "value": "CRITICAL"
          }
        ],
        "combinator": "or"
      }
    },
    {
      "id": "alert_discord_critical",
      "name": "Discord Alert - Critical",
      "type": "discord",
      "position": [1100, 100],
      "parameters": {
        "webhookUrl": "{{env.DISCORD_WEBHOOK_OPS}}",
        "content": "🚨 **CRITICAL INFRASTRUCTURE ALERT**\n\n{{steps.analyze_health.data.content}}",
        "username": "Olivia - DevOps Monitor",
        "avatarUrl": "https://api.dicebear.com/7.x/bottts/svg?seed=olivia"
      }
    },
    {
      "id": "create_github_issue",
      "name": "Create GitHub Issue for Critical",
      "type": "http-request",
      "position": [1100, 200],
      "parameters": {
        "method": "POST",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/issues",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}",
          "Accept": "application/vnd.github.v3+json"
        },
        "body": {
          "title": "🚨 [Auto] Critical Infrastructure Issue Detected",
          "body": "## Automated Alert from Olivia\n\n{{steps.analyze_health.data.content}}\n\n---\n*This issue was automatically created by the DevOps Monitor workflow.*",
          "labels": ["critical", "automated", "infrastructure"]
        }
      }
    },
    {
      "id": "log_healthy",
      "name": "Log Healthy Status",
      "type": "discord",
      "position": [1100, 300],
      "parameters": {
        "webhookUrl": "{{env.DISCORD_WEBHOOK_OPS}}",
        "content": "✅ **Hourly Health Check - All Systems Normal**\n\n{{steps.analyze_health.data.content}}",
        "username": "Olivia - DevOps Monitor",
        "avatarUrl": "https://api.dicebear.com/7.x/bottts/svg?seed=olivia"
      }
    }
  ],
  "connections": {
    "trigger": {
      "main": [[
        { "node": "check_worker_errors", "type": "default", "index": 0 },
        { "node": "check_api_health", "type": "default", "index": 0 },
        { "node": "check_github_actions", "type": "default", "index": 0 }
      ]]
    },
    "check_worker_errors": {
      "main": [[{ "node": "aggregate_health", "type": "default", "index": 0 }]]
    },
    "check_api_health": {
      "main": [[{ "node": "aggregate_health", "type": "default", "index": 0 }]]
    },
    "check_github_actions": {
      "main": [[{ "node": "aggregate_health", "type": "default", "index": 0 }]]
    },
    "aggregate_health": {
      "main": [[{ "node": "analyze_health", "type": "default", "index": 0 }]]
    },
    "analyze_health": {
      "main": [[{ "node": "check_critical", "type": "default", "index": 0 }]]
    },
    "check_critical": {
      "main": [
        [{ "node": "alert_discord_critical", "type": "true", "index": 0 }],
        [{ "node": "log_healthy", "type": "false", "index": 0 }]
      ]
    },
    "alert_discord_critical": {
      "main": [[{ "node": "create_github_issue", "type": "default", "index": 0 }]]
    }
  },
  "settings": {
    "timezone": "UTC",
    "cloudflare": {
      "retryPolicy": {
        "limit": 3,
        "delay": "10 seconds",
        "backoff": "exponential"
      }
    }
  }
}
```

### Success Metrics
- [ ] Runs hourly without failure
- [ ] Correctly identifies CRITICAL vs HEALTHY status
- [ ] Creates Discord alerts within 2 minutes of issue detection
- [ ] Auto-creates GitHub issues for critical problems

---

## Agent #2: Sophie (Support Bot)

### Purpose
Automatically handle GitHub issues and Discord support questions.

### Trigger
- **GitHub Webhook**: New issue created
- **GitHub Webhook**: Issue comment added
- **Discord Bot**: Message in #support channel

### Workflow Definition

```json
{
  "id": "wf_sophie_support_bot",
  "name": "Sophie - Support Bot",
  "description": "Automatic GitHub issue triage and response",
  "active": true,
  "nodes": [
    {
      "id": "trigger",
      "name": "GitHub Issue Webhook",
      "type": "webhook-trigger",
      "position": [100, 200],
      "parameters": {
        "path": "/webhook/github/issues",
        "method": "POST",
        "authentication": "header",
        "authConfig": {
          "headerName": "X-Hub-Signature-256",
          "secret": "{{env.GITHUB_WEBHOOK_SECRET}}"
        }
      }
    },
    {
      "id": "parse_issue",
      "name": "Parse Issue Data",
      "type": "parse-json",
      "position": [300, 200],
      "parameters": {
        "input": "{{trigger.data.body}}"
      }
    },
    {
      "id": "classify_issue",
      "name": "AI Classification",
      "type": "ai-chat",
      "position": [500, 200],
      "parameters": {
        "model": "gpt-4o-mini",
        "systemPrompt": "You are Sophie, a friendly support agent for AgentPod. Classify GitHub issues accurately and helpfully.",
        "userPrompt": "Classify this GitHub issue:\n\nTitle: {{steps.parse_issue.data.issue.title}}\nBody: {{steps.parse_issue.data.issue.body}}\n\nRespond with JSON:\n{\n  \"category\": \"bug\" | \"feature-request\" | \"question\" | \"documentation\" | \"security\",\n  \"priority\": 1-5 (5 is highest),\n  \"labels\": [\"suggested\", \"labels\"],\n  \"needsMoreInfo\": true/false,\n  \"suggestedResponse\": \"A helpful response to post as a comment\",\n  \"canAutoResolve\": true/false\n}",
        "temperature": 0.2,
        "responseFormat": "json"
      }
    },
    {
      "id": "add_labels",
      "name": "Add Labels to Issue",
      "type": "http-request",
      "position": [700, 100],
      "parameters": {
        "method": "POST",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/issues/{{steps.parse_issue.data.issue.number}}/labels",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}",
          "Accept": "application/vnd.github.v3+json"
        },
        "body": {
          "labels": "{{steps.classify_issue.data.labels}}"
        }
      }
    },
    {
      "id": "post_comment",
      "name": "Post Helpful Comment",
      "type": "http-request",
      "position": [700, 200],
      "parameters": {
        "method": "POST",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/issues/{{steps.parse_issue.data.issue.number}}/comments",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}",
          "Accept": "application/vnd.github.v3+json"
        },
        "body": {
          "body": "👋 Hi @{{steps.parse_issue.data.issue.user.login}}!\n\n{{steps.classify_issue.data.suggestedResponse}}\n\n---\n*🤖 I'm Sophie, AgentPod's support bot. A human will review this shortly if needed.*"
        }
      }
    },
    {
      "id": "check_high_priority",
      "name": "Check if High Priority",
      "type": "condition",
      "position": [700, 300],
      "parameters": {
        "conditions": [
          {
            "field": "{{steps.classify_issue.data.priority}}",
            "operator": "gte",
            "value": 4
          },
          {
            "field": "{{steps.classify_issue.data.category}}",
            "operator": "equals",
            "value": "security"
          }
        ],
        "combinator": "or"
      }
    },
    {
      "id": "alert_high_priority",
      "name": "Alert High Priority Issue",
      "type": "discord",
      "position": [900, 300],
      "parameters": {
        "webhookUrl": "{{env.DISCORD_WEBHOOK_OPS}}",
        "content": "🔔 **High Priority Issue Needs Attention**\n\n**Title:** {{steps.parse_issue.data.issue.title}}\n**Category:** {{steps.classify_issue.data.category}}\n**Priority:** {{steps.classify_issue.data.priority}}/5\n**URL:** {{steps.parse_issue.data.issue.html_url}}",
        "username": "Sophie - Support Bot",
        "avatarUrl": "https://api.dicebear.com/7.x/bottts/svg?seed=sophie"
      }
    },
    {
      "id": "log_support_action",
      "name": "Log Support Action",
      "type": "d1-query",
      "position": [900, 200],
      "parameters": {
        "database": "agentpod-workflows",
        "query": "INSERT INTO support_actions (issue_number, category, priority, action_taken, created_at) VALUES (?, ?, ?, ?, ?)",
        "bindings": [
          "{{steps.parse_issue.data.issue.number}}",
          "{{steps.classify_issue.data.category}}",
          "{{steps.classify_issue.data.priority}}",
          "auto-labeled-and-responded",
          "{{trigger.data.timestamp}}"
        ]
      }
    }
  ],
  "connections": {
    "trigger": {
      "main": [[{ "node": "parse_issue", "type": "default", "index": 0 }]]
    },
    "parse_issue": {
      "main": [[{ "node": "classify_issue", "type": "default", "index": 0 }]]
    },
    "classify_issue": {
      "main": [[
        { "node": "add_labels", "type": "default", "index": 0 },
        { "node": "post_comment", "type": "default", "index": 0 },
        { "node": "check_high_priority", "type": "default", "index": 0 }
      ]]
    },
    "check_high_priority": {
      "main": [
        [{ "node": "alert_high_priority", "type": "true", "index": 0 }],
        [{ "node": "log_support_action", "type": "false", "index": 0 }]
      ]
    },
    "alert_high_priority": {
      "main": [[{ "node": "log_support_action", "type": "default", "index": 0 }]]
    }
  }
}
```

### GitHub Webhook Setup

1. Go to `github.com/rakeshgangwar/agentpod/settings/hooks`
2. Add webhook:
   - **Payload URL**: `https://agentpod-sandbox.workers.dev/webhook/github/issues`
   - **Content type**: `application/json`
   - **Secret**: Generate and save as `GITHUB_WEBHOOK_SECRET`
   - **Events**: Select "Issues" and "Issue comments"

### Success Metrics
- [ ] All new issues get labeled within 1 minute
- [ ] Helpful response posted within 2 minutes
- [ ] High-priority issues trigger Discord alert
- [ ] Classification accuracy > 85%

---

## Agent #3: Pete (Product Analyst)

### Purpose
Weekly analysis of GitHub issues to identify trends and update roadmap.

### Trigger
- **Schedule**: Every Monday at 9am UTC (`0 9 * * 1`)

### Workflow Definition

```json
{
  "id": "wf_pete_product_analyst",
  "name": "Pete - Weekly Product Analysis",
  "description": "Analyze GitHub issues and generate roadmap insights",
  "active": true,
  "nodes": [
    {
      "id": "trigger",
      "name": "Weekly Monday 9am",
      "type": "schedule-trigger",
      "position": [100, 200],
      "parameters": {
        "cron": "0 9 * * 1",
        "timezone": "UTC"
      }
    },
    {
      "id": "fetch_open_issues",
      "name": "Fetch Open Issues",
      "type": "http-request",
      "position": [300, 150],
      "parameters": {
        "method": "GET",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/issues?state=open&per_page=100",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}",
          "Accept": "application/vnd.github.v3+json"
        }
      }
    },
    {
      "id": "fetch_closed_this_week",
      "name": "Fetch Closed This Week",
      "type": "http-request",
      "position": [300, 250],
      "parameters": {
        "method": "GET",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/issues?state=closed&since={{steps.trigger.data.lastWeekDate}}&per_page=100",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}",
          "Accept": "application/vnd.github.v3+json"
        }
      }
    },
    {
      "id": "fetch_recent_commits",
      "name": "Fetch Recent Commits",
      "type": "http-request",
      "position": [300, 350],
      "parameters": {
        "method": "GET",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/commits?since={{steps.trigger.data.lastWeekDate}}&per_page=50",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}",
          "Accept": "application/vnd.github.v3+json"
        }
      }
    },
    {
      "id": "analyze_data",
      "name": "AI Analysis",
      "type": "ai-chat",
      "position": [500, 250],
      "parameters": {
        "model": "claude-3-5-sonnet-20241022",
        "systemPrompt": "You are Pete, a product analyst for AgentPod. Generate insightful weekly reports that help prioritize development work.",
        "userPrompt": "Analyze this week's GitHub activity for AgentPod:\n\n## Open Issues ({{steps.fetch_open_issues.data.length}} total)\n{{steps.fetch_open_issues.data}}\n\n## Closed This Week ({{steps.fetch_closed_this_week.data.length}} total)\n{{steps.fetch_closed_this_week.data}}\n\n## Commits This Week ({{steps.fetch_recent_commits.data.length}} total)\n{{steps.fetch_recent_commits.data}}\n\nGenerate a weekly report with:\n1. **Executive Summary** (2-3 sentences)\n2. **Key Accomplishments** (what was shipped)\n3. **Top Feature Requests** (ranked by demand/mentions)\n4. **Critical Bugs** (if any)\n5. **Recommended Priorities** for next week\n6. **Trends** (recurring themes or patterns)\n\nFormat as Markdown suitable for a team update.",
        "temperature": 0.4,
        "maxTokens": 2000
      }
    },
    {
      "id": "send_discord_summary",
      "name": "Post to Discord",
      "type": "discord",
      "position": [700, 150],
      "parameters": {
        "webhookUrl": "{{env.DISCORD_WEBHOOK_OPS}}",
        "content": "📊 **Weekly Product Report - AgentPod**\n\n{{steps.analyze_data.data.content}}",
        "username": "Pete - Product Analyst",
        "avatarUrl": "https://api.dicebear.com/7.x/bottts/svg?seed=pete"
      }
    },
    {
      "id": "send_email_report",
      "name": "Email Weekly Report",
      "type": "email",
      "position": [700, 250],
      "parameters": {
        "to": "{{env.ALERT_EMAIL}}",
        "from": "pete@agentpod.app",
        "subject": "📊 AgentPod Weekly Report - {{trigger.data.date}}",
        "body": "{{steps.analyze_data.data.content}}",
        "provider": "resend",
        "apiKey": "{{env.RESEND_API_KEY}}"
      }
    },
    {
      "id": "store_report",
      "name": "Store Report in R2",
      "type": "r2-storage",
      "position": [700, 350],
      "parameters": {
        "operation": "put",
        "bucket": "agentpod-reports",
        "key": "weekly/{{trigger.data.date}}-product-report.md",
        "body": "{{steps.analyze_data.data.content}}",
        "contentType": "text/markdown"
      }
    }
  ],
  "connections": {
    "trigger": {
      "main": [[
        { "node": "fetch_open_issues", "type": "default", "index": 0 },
        { "node": "fetch_closed_this_week", "type": "default", "index": 0 },
        { "node": "fetch_recent_commits", "type": "default", "index": 0 }
      ]]
    },
    "fetch_open_issues": {
      "main": [[{ "node": "analyze_data", "type": "default", "index": 0 }]]
    },
    "fetch_closed_this_week": {
      "main": [[{ "node": "analyze_data", "type": "default", "index": 0 }]]
    },
    "fetch_recent_commits": {
      "main": [[{ "node": "analyze_data", "type": "default", "index": 0 }]]
    },
    "analyze_data": {
      "main": [[
        { "node": "send_discord_summary", "type": "default", "index": 0 },
        { "node": "send_email_report", "type": "default", "index": 0 },
        { "node": "store_report", "type": "default", "index": 0 }
      ]]
    }
  }
}
```

### Success Metrics
- [ ] Report generated every Monday by 9:30am UTC
- [ ] Report accurately summarizes week's activity
- [ ] Recommendations align with actual priorities
- [ ] Historical reports accessible in R2

---

## Agent #4: Morgan (Content Creator)

### Purpose
Generate weekly blog posts and social media content about AgentPod development.

### Trigger
- **Schedule**: Every Wednesday at 10am UTC (`0 10 * * 3`)

### Workflow Definition

```json
{
  "id": "wf_morgan_content_creator",
  "name": "Morgan - Weekly Content Generator",
  "description": "Generate blog posts and social content from development activity",
  "active": true,
  "nodes": [
    {
      "id": "trigger",
      "name": "Weekly Wednesday 10am",
      "type": "schedule-trigger",
      "position": [100, 200],
      "parameters": {
        "cron": "0 10 * * 3",
        "timezone": "UTC"
      }
    },
    {
      "id": "fetch_commits",
      "name": "Fetch Week's Commits",
      "type": "http-request",
      "position": [300, 150],
      "parameters": {
        "method": "GET",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/commits?since={{trigger.data.lastWeekDate}}&per_page=50",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}"
        }
      }
    },
    {
      "id": "fetch_prs",
      "name": "Fetch Merged PRs",
      "type": "http-request",
      "position": [300, 250],
      "parameters": {
        "method": "GET",
        "url": "https://api.github.com/repos/{{env.GITHUB_OWNER}}/{{env.GITHUB_REPO}}/pulls?state=closed&sort=updated&direction=desc&per_page=20",
        "headers": {
          "Authorization": "Bearer {{env.GITHUB_TOKEN}}"
        }
      }
    },
    {
      "id": "generate_blog_post",
      "name": "Generate Blog Post",
      "type": "ai-chat",
      "position": [500, 200],
      "parameters": {
        "model": "claude-3-5-sonnet-20241022",
        "systemPrompt": "You are Morgan, a technical content creator for AgentPod. Write engaging, informative blog posts about AI development tools. Your tone is conversational but technical. You love sharing behind-the-scenes development insights.",
        "userPrompt": "Write a 'Week in AgentPod' blog post based on this development activity:\n\n## Recent Commits\n{{steps.fetch_commits.data}}\n\n## Merged PRs\n{{steps.fetch_prs.data}}\n\nWrite a 1000-1500 word blog post that:\n1. Has an engaging title\n2. Summarizes the week's main accomplishments\n3. Explains 1-2 features in depth (technical but accessible)\n4. Includes code snippets where relevant\n5. Ends with what's coming next\n6. Has SEO-friendly headings\n\nFormat as Markdown with frontmatter (title, description, date, tags).",
        "temperature": 0.7,
        "maxTokens": 3000
      }
    },
    {
      "id": "generate_tweet_thread",
      "name": "Generate Twitter Thread",
      "type": "ai-chat",
      "position": [500, 350],
      "parameters": {
        "model": "gpt-4o-mini",
        "systemPrompt": "You are Morgan, creating Twitter threads about AgentPod development. Be concise, use emojis appropriately, and make technical content accessible.",
        "userPrompt": "Based on this blog post, create a Twitter thread (5-7 tweets):\n\n{{steps.generate_blog_post.data.content}}\n\nEach tweet should:\n- Be under 280 characters\n- Use relevant emojis\n- Include a hook in tweet 1\n- End with a CTA (link to blog, try AgentPod, etc.)\n\nFormat as JSON array: [{\"tweet\": \"text\", \"order\": 1}, ...]",
        "temperature": 0.8,
        "responseFormat": "json"
      }
    },
    {
      "id": "human_review",
      "name": "Human Review Before Publishing",
      "type": "approval",
      "position": [700, 200],
      "parameters": {
        "message": "Review this week's content before publishing",
        "approvers": ["{{env.ALERT_EMAIL}}"],
        "timeout": "24 hours",
        "data": {
          "blogPost": "{{steps.generate_blog_post.data.content}}",
          "tweetThread": "{{steps.generate_tweet_thread.data}}"
        }
      }
    },
    {
      "id": "store_blog_post",
      "name": "Store Blog Post",
      "type": "r2-storage",
      "position": [900, 150],
      "parameters": {
        "operation": "put",
        "bucket": "agentpod-content",
        "key": "blog/{{trigger.data.date}}-weekly-update.md",
        "body": "{{steps.generate_blog_post.data.content}}"
      }
    },
    {
      "id": "notify_published",
      "name": "Notify Content Published",
      "type": "discord",
      "position": [900, 250],
      "parameters": {
        "webhookUrl": "{{env.DISCORD_WEBHOOK_OPS}}",
        "content": "📝 **New Blog Post Generated**\n\nTitle: {{steps.generate_blog_post.data.title}}\n\nReview and publish: [R2 Storage Link]\n\nTwitter thread ready: {{steps.generate_tweet_thread.data.length}} tweets",
        "username": "Morgan - Content Creator"
      }
    }
  ],
  "connections": {
    "trigger": {
      "main": [[
        { "node": "fetch_commits", "type": "default", "index": 0 },
        { "node": "fetch_prs", "type": "default", "index": 0 }
      ]]
    },
    "fetch_commits": {
      "main": [[{ "node": "generate_blog_post", "type": "default", "index": 0 }]]
    },
    "fetch_prs": {
      "main": [[{ "node": "generate_blog_post", "type": "default", "index": 0 }]]
    },
    "generate_blog_post": {
      "main": [[
        { "node": "generate_tweet_thread", "type": "default", "index": 0 },
        { "node": "human_review", "type": "default", "index": 0 }
      ]]
    },
    "human_review": {
      "main": [[
        { "node": "store_blog_post", "type": "default", "index": 0 },
        { "node": "notify_published", "type": "default", "index": 0 }
      ]]
    }
  }
}
```

### Success Metrics
- [ ] Blog post generated every Wednesday
- [ ] Content quality suitable for publishing (minimal edits needed)
- [ ] Twitter thread engaging (good engagement rate when posted)
- [ ] Human approval workflow works smoothly

---

## Agent #5: Kai (Code Contributor)

### Purpose
Automatically fix simple bugs and create PRs for "good-first-issue" labeled items.

### Trigger
- **GitHub Webhook**: Issue labeled with "good-first-issue" or "automated-fix"

### Workflow Overview

Unlike other agents that run as Cloudflare Workflows, Kai uses **OpenCode in a Docker sandbox**:

```yaml
Flow:
  1. GitHub Webhook → Cloudflare Workflow triggered
  2. Workflow creates new sandbox via Management API
  3. Sandbox clones AgentPod repo
  4. OpenCode agent analyzes issue and writes fix
  5. Workflow creates PR via GitHub API
  6. Sandbox destroyed after completion
```

### Implementation Notes

Kai is more complex because it requires:
1. **Sandbox orchestration** (create, monitor, destroy)
2. **OpenCode integration** (AI coding agent)
3. **Git operations** (branch, commit, push)
4. **PR creation** (GitHub API)

This will be implemented in Phase 2 after the simpler agents are working.

---

## Implementation Timeline

### Week 1: Foundation + Olivia + Pete

| Day | Task |
|-----|------|
| Day 1 | Set up all environment variables and API keys |
| Day 2 | Deploy Olivia workflow, test hourly health checks |
| Day 3 | Refine Olivia prompts, add more data sources |
| Day 4 | Deploy Pete workflow, run first analysis |
| Day 5 | Set up GitHub webhook for Sophie |

### Week 2: Sophie + Morgan + Polish

| Day | Task |
|-----|------|
| Day 6 | Deploy Sophie workflow, test with sample issues |
| Day 7 | Tune Sophie classification prompts |
| Day 8 | Deploy Morgan workflow, generate first blog post |
| Day 9 | Human approval flow testing |
| Day 10 | End-to-end testing, fix issues |
| Day 11-12 | Documentation, demo recording |
| Day 13-14 | Beta launch, collect feedback |

---

## Monitoring & Observability

### Workflow Execution Dashboard

Track via AgentPod Management API:

```typescript
// GET /api/workflows/executions?workflowId=wf_olivia_devops_monitor
{
  "executions": [
    {
      "id": "exec_123",
      "status": "completed",
      "startedAt": "2025-12-27T06:00:00Z",
      "completedAt": "2025-12-27T06:00:45Z",
      "durationMs": 45000,
      "completedSteps": ["trigger", "check_worker_errors", "analyze_health", "log_healthy"]
    }
  ],
  "stats": {
    "total": 168,
    "completed": 165,
    "errored": 3,
    "avgDurationMs": 42000
  }
}
```

### Discord Ops Channel Structure

```
#agentpod-ops
├── 🤖 Olivia - Health Checks (hourly)
├── 🎧 Sophie - Support Actions (on-demand)
├── 📊 Pete - Weekly Reports (Mondays)
├── 📝 Morgan - Content Updates (Wednesdays)
└── 💻 Kai - Code Contributions (on-demand)
```

### Cost Tracking

| Agent | Frequency | AI Cost/Run | Monthly Cost |
|-------|-----------|-------------|--------------|
| Olivia | 24/day | $0.005 | $3.60 |
| Sophie | ~10/day | $0.01 | $3.00 |
| Pete | 4/month | $0.10 | $0.40 |
| Morgan | 4/month | $0.15 | $0.60 |
| **Total** | - | - | **~$8/month** |

---

## Success Criteria (After 2 Weeks)

### Quantitative

| Metric | Target |
|--------|--------|
| Olivia uptime | 99%+ (runs every hour) |
| Sophie response time | < 2 minutes from issue creation |
| Sophie classification accuracy | > 85% |
| Pete report quality | Actionable insights in every report |
| Morgan content quality | < 30 min editing needed per post |
| Total time saved | 10-15 hours/week |
| Infrastructure cost | < $10/month |

### Qualitative

- [ ] You trust Olivia to catch issues before you notice them
- [ ] Sophie reduces your GitHub notification burden significantly
- [ ] Pete's reports influence your weekly planning
- [ ] Morgan's content is good enough to publish with minor edits
- [ ] You feel like you have a team working 24/7

---

## Next Steps After POC

### Phase 2 (Weeks 3-4)
- [ ] Implement Kai (code contributor)
- [ ] Add knowledge base for Sophie (RAG with docs/)
- [ ] Integrate social media posting for Morgan

### Phase 3 (Weeks 5-8)
- [ ] Build agent marketplace
- [ ] Create workflow templates for other users
- [ ] Add multi-agent orchestration

### Phase 4 (Months 3-6)
- [ ] Scale to serve multiple users
- [ ] Monetization (subscription tiers)
- [ ] Advanced analytics dashboard

---

## Related Documents

- Autonomous Startup Blueprint, Workflow Builder Plan, Cloudflare Implementation Guide —
  all three were pre-pivot documents and none of them survived into this repo. The links
  that used to be here pointed at `docs/vision/` and sibling files that no longer exist.

---

*Document created: December 2025*  
*Last updated: December 2025*
