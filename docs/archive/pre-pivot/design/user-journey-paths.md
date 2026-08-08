# Generative UI - User Journey Paths

**Application:** AgentPod  
**Date:** December 2024

Comprehensive mapping of all possible user journey paths through the intent-based generative UI system.

---

## Overview

The generative UI system transforms user interactions from "navigate to pages" to "state intent, receive interface". This document maps every possible path a user might take.

### Journey Structure

```
Entry Point → Intent Expression → Intent Detection → View Generation → Interaction → Resolution
```

---

## Entry Points

### E1: App Launch (Cold Start)
- User opens app for first time
- No prior context
- Connection not established

### E2: App Launch (Warm Start)
- User returns to app
- Has existing projects
- May have active sessions

### E3: Notification Tap
- User taps push notification
- Deep link to specific context
- Immediate intent known

### E4: Quick Action (Mobile)
- 3D Touch / Long press on app icon
- Pre-defined shortcuts
- Immediate action

---

## Journey Category 1: Getting Started

### J1.1: First-Time Setup
```
E1 → Setup Required → Connection Setup → API URL Entry → Test Connection → Success → Home
                                                       → Failure → Retry/Help
```

**States:**
- `setup.idle` - Waiting for input
- `setup.testing` - Testing connection
- `setup.success` - Ready to proceed
- `setup.error` - Connection failed

**Patterns Used:**
- Initial CTA
- Verification (test connection)
- Caveat (limitations disclaimer)

---

### J1.2: Returning User (No Active Sessions)
```
E2 → Home → "What's on your mind?" → Intent Input → ...
                                   → Quick Actions → ...
                                   → Recent Projects → ...
```

**Generated Views:**
- Intent-first home with suggestions
- Quick action chips
- Recent project cards

---

### J1.3: Returning User (Active Sessions)
```
E2 → Home → Attention Banner → [Needs Attention Items] → Handle Item
          → Active Sessions → [Session Cards] → Resume Session
          → Intent Input → ...
```

**Attention Item Types:**
- Permission requests
- Errors requiring action
- Sessions waiting for input
- Completed tasks for review

---

## Journey Category 2: Intent Expression

### J2.1: Direct Text Input
```
Home → Intent Input → Type intent → Submit
```

**Input Processing:**
1. User types natural language
2. Real-time suggestions appear
3. Enter to submit
4. Intent detection runs

---

### J2.2: Quick Action Selection
```
Home → Quick Actions → Tap action → Pre-filled intent → [Optional edit] → Submit
```

**Quick Actions:**
| Action | Pre-filled Intent | Generated View |
|--------|-------------------|----------------|
| "Projects" | "Show my projects" | Projects Grid |
| "New Session" | "Start a new session" | Project Picker → Session |
| "Attention" | "What needs attention?" | Attention Dashboard |
| "Activity" | "Show recent activity" | Activity Feed |
| "Settings" | "Open settings" | Settings Page |

---

### J2.3: Recent Item Selection
```
Home → Recent Context → Tap project/session → Resume context
```

---

### J2.4: Voice Input (Future)
```
Home → Tap mic → Speak intent → Transcription → Submit
```

---

## Journey Category 3: Intent Detection & Resolution

### J3.1: Clear Intent - Navigation
```
Intent: "Show my projects"
         ↓
Detection: { type: "navigate", entity: "projects", confidence: 0.95 }
         ↓
Resolution: Navigate to /projects
         ↓
View: Projects Grid
```

**Navigation Intents:**
| Input Pattern | Entity | View |
|---------------|--------|------|
| "show/open/go to projects" | projects | Projects Grid |
| "settings" | settings | Settings Page |
| "activity/history" | activity | Activity Feed |
| "project X" | project:X | Project Detail |
| "session Y in project X" | session:Y | Chat View |

---

### J3.2: Clear Intent - Action
```
Intent: "Start a session in frontend project"
         ↓
Detection: { type: "action", action: "create_session", entity: "project:frontend", confidence: 0.90 }
         ↓
Resolution: Create session in frontend project
         ↓
View: Chat Interface (new session)
```

**Action Intents:**
| Input Pattern | Action | Flow |
|---------------|--------|------|
| "start session in X" | create_session | Create → Chat |
| "stop project X" | stop_project | Confirmation → Stop |
| "deploy X" | deploy | Confirmation → Progress |
| "run tests in X" | run_command | Progress → Results |

---

### J3.3: Clear Intent - Query
```
Intent: "Show logs for backend project"
         ↓
Detection: { type: "query", subject: "logs", entity: "project:backend", confidence: 0.88 }
         ↓
Resolution: Fetch logs for backend
         ↓
View: Logs View (filtered)
```

**Query Intents:**
| Input Pattern | Subject | View |
|---------------|---------|------|
| "logs for X" | logs | Logs View |
| "files in X" | files | File Browser |
| "find files with Y" | search | Search Results |
| "what changed in X" | diff | Diff View |

---

### J3.4: Clear Intent - Status Check
```
Intent: "What's happening?"
         ↓
Detection: { type: "status", scope: "all", confidence: 0.85 }
         ↓
Resolution: Aggregate status from all projects
         ↓
View: Status Dashboard
```

**Status Intents:**
| Input Pattern | Scope | View |
|---------------|-------|------|
| "what's happening" | all | Status Dashboard |
| "any issues/problems" | errors | Error Summary |
| "what needs attention" | attention | Attention List |
| "status of X" | project:X | Project Status |

---

### J3.5: Clear Intent - Chat/Help
```
Intent: "Help me fix the auth bug"
         ↓
Detection: { type: "chat", context: "auth bug", confidence: 0.82 }
         ↓
Resolution: Create or resume session
         ↓
View: Chat Interface (with context)
```

---

### J3.6: Ambiguous Intent - Follow Up Required
```
Intent: "Show me the thing from yesterday"
         ↓
Detection: { type: "ambiguous", confidence: 0.45 }
         ↓
Follow Up: "I found a few things from yesterday:"
           - Session in frontend (auth work)
           - Session in backend (API fixes)
           - Activity log
           
           "Which would you like to see?"
         ↓
User Selection → Resolved Intent → View
```

**Follow Up Patterns:**
- Multiple matching entities
- Missing required context
- Unclear action type
- Time reference ambiguity

---

### J3.7: Hybrid Intent
```
Intent: "Show frontend project and start a chat"
         ↓
Detection: { type: "hybrid", intents: [
  { type: "navigate", entity: "project:frontend" },
  { type: "action", action: "create_session" }
]}
         ↓
Resolution: Navigate + Create
         ↓
View: Project Detail with new chat session
```

---

### J3.8: Unknown Intent - Fallback
```
Intent: "asdfghjkl"
         ↓
Detection: { type: "unknown", confidence: 0.1 }
         ↓
Fallback: "I didn't understand that. Try:
           - 'Show my projects'
           - 'Start a session'
           - 'What needs attention?'"
         ↓
User Retry → ...
```

---

## Journey Category 4: Project Management

### J4.1: View All Projects
```
Intent: "Show my projects"
         ↓
View: Projects Grid
      ┌────────────────────────────────────────┐
      │ [Search: _______________] [+ New]      │
      │                                        │
      │ ┌────────┐ ┌────────┐ ┌────────┐      │
      │ │frontend│ │backend │ │ api    │      │
      │ │ 🟢 3   │ │ 🟡 1   │ │ ⚫ 0   │      │
      │ └────────┘ └────────┘ └────────┘      │
      └────────────────────────────────────────┘
         ↓
Actions: Tap project → Project Detail
         Tap + New → Create Project
         Search → Filter projects
```

---

### J4.2: Create New Project
```
Intent: "Create a new project"
         ↓
View: Project Creation Wizard
      Step 1: Name & Description
      Step 2: Select Container Tier
      Step 3: Configure Settings
      Step 4: Review & Create
         ↓
Actions: Complete → Creating... → Project Created → Project Detail
         Cancel → Back to Projects
```

**Patterns Used:**
- Templates (tier presets)
- Verification (review before create)
- Cost Estimates (tier pricing)

---

### J4.3: Project Detail View
```
Navigation: Projects → Tap Project
         ↓
View: Split Layout
      ┌──────────────────────────────────────────┐
      │ [project name]  [🟢 Running]  [⚙️] [▶️] │
      ├──────────────────────────────────────────┤
      │ ┌─────────┐                              │
      │ │Sessions │  [Session content area]      │
      │ │ • ses1  │                              │
      │ │ • ses2  │                              │
      │ │ + New   │                              │
      │ └─────────┘                              │
      └──────────────────────────────────────────┘
         ↓
Tabs: Chat | Files | Logs | Settings
```

---

### J4.4: Project Quick Actions
```
Project Card → Long press / Right click
         ↓
Context Menu:
  - Start Container
  - Stop Container
  - New Session
  - View Logs
  - Settings
  - Delete
         ↓
Select Action → Confirmation (if destructive) → Execute
```

---

## Journey Category 5: Session & Chat

### J5.1: Start New Session
```
Intent: "Start a session in frontend"
         ↓
Resolution: Check project status
         ↓
If project stopped: "frontend is stopped. Start it first?"
                    [Start & Create Session] [Cancel]
         ↓
If project running: Create session → Chat View
         ↓
View: Chat Interface (Empty State)
      ┌──────────────────────────────────────────┐
      │ Session: New Session                     │
      │ ─────────────────────────────────────── │
      │                                          │
      │        No messages yet                   │
      │        Send a message to start.          │
      │                                          │
      │ ─────────────────────────────────────── │
      │ [Type a message... / for commands, @ ] │
      │                              [Send]     │
      └──────────────────────────────────────────┘
```

---

### J5.2: Resume Existing Session
```
Intent: "Continue my frontend session"
OR
Navigation: Project → Sessions → Tap session
         ↓
View: Chat Interface (With History)
      - Load message history
      - Restore scroll position
      - Show any pending permissions
```

---

### J5.3: Chat Interaction - Simple Message
```
Chat View → Type message → Send
         ↓
State: isRunning = true
         ↓
Display: Loading indicator ("Thinking...")
         ↓
SSE Events:
  message.updated → Add message
  message.part.updated → Stream content
  session.idle → isRunning = false
         ↓
Display: Assistant message with content
```

---

### J5.4: Chat Interaction - Tool Calls
```
Message sent → AI decides to use tools
         ↓
SSE: message.part.updated (type: "tool")
         ↓
Display: Tool Call UI
         ┌──────────────────────────────────────┐
         │ 🔄 read                              │
         │    Reading src/lib/api.ts           │
         │    [▼ Show details]                  │
         └──────────────────────────────────────┘
         ↓
Tool completes:
         ┌──────────────────────────────────────┐
         │ ✅ read (completed)                  │
         │    src/lib/api.ts                    │
         │    [▼ Show details]                  │
         │    ┌────────────────────────────┐   │
         │    │ 1 | import { invoke }...   │   │
         │    │ 2 | export async function  │   │
         │    └────────────────────────────┘   │
         └──────────────────────────────────────┘
```

**Tool-Specific UIs:**
| Tool | UI Component | Features |
|------|--------------|----------|
| Read | FileViewer | Syntax highlight, line numbers |
| Edit | DiffViewer | Old vs new, inline diff |
| Write | CreatePreview | New file content |
| Bash | TerminalOutput | Command + output |
| Glob/Grep | SearchResults | File list, click to view |
| WebFetch | URLCard | Preview with metadata |

---

### J5.5: Chat Interaction - Permission Required
```
Tool execution → Permission needed
         ↓
SSE: permission.updated
         ↓
Display: Permission Bar (sticky bottom)
         ┌──────────────────────────────────────┐
         │ 🔒 AI wants to edit src/api.ts      │
         │                                      │
         │ [Allow Once] [Always Allow] [Reject] │
         └──────────────────────────────────────┘
         ↓
User action:
  Allow Once → Continue, don't remember
  Always Allow → Continue, remember for pattern
  Reject → Stop tool, AI continues differently
         ↓
SSE: permission.replied → Remove from bar
```

---

### J5.6: Chat Interaction - Cancel/Abort
```
Chat running → User wants to stop
         ↓
Action: Tap Stop button
         ↓
API: opencodeAbortSession()
         ↓
State: isRunning = false
         ↓
Display: Message shows "(cancelled)"
```

---

### J5.7: Session Management
```
Chat View → Session sidebar
         ↓
Actions:
  - Tap session → Switch to session
  - New Session → Create new
  - Delete session → Confirmation → Delete
  - Rename session → Edit name → Save
```

---

## Journey Category 6: File Operations

### J6.1: Browse Files
```
Intent: "Show files in frontend project"
OR
Navigation: Project → Files tab
         ↓
View: File Browser
      ┌──────────────────────────────────────────┐
      │ 📁 src/                                  │
      │   📁 lib/                                │
      │     📄 api.ts                            │
      │     📄 utils.ts                          │
      │   📁 routes/                             │
      │   📄 app.css                             │
      └──────────────────────────────────────────┘
         ↓
Actions:
  Tap folder → Expand/collapse
  Tap file → File preview
```

---

### J6.2: View File Content
```
File Browser → Tap file
         ↓
View: File Viewer (Split or Modal)
      - Syntax highlighting
      - Line numbers
      - Copy button
      - "Ask about this file" action
         ↓
Actions:
  Ask about file → Chat with file context
  Close → Back to browser
```

---

### J6.3: Search Files
```
Intent: "Find files with 'useState' in frontend"
         ↓
View: Search Results
      ┌──────────────────────────────────────────┐
      │ Search: useState          [x]           │
      │ Found 8 files                           │
      │ ──────────────────────────────────────  │
      │ 📄 src/components/Counter.tsx           │
      │    Line 5: const [count, setCount] =... │
      │ 📄 src/hooks/useAuth.ts                 │
      │    Line 12: const [user, setUser] = ... │
      │ ...                                      │
      └──────────────────────────────────────────┘
         ↓
Actions:
  Tap result → File viewer at line
  New search → Update results
```

---

## Journey Category 7: Monitoring & Status

### J7.1: View Logs
```
Intent: "Show logs for backend"
OR
Navigation: Project → Logs tab
         ↓
View: Log Viewer
      ┌──────────────────────────────────────────┐
      │ [All ▼] [Filter: _______] [🔄 Auto]     │
      │ ──────────────────────────────────────  │
      │ 14:32:01 [INFO]  Server started         │
      │ 14:32:05 [DEBUG] Connection from...     │
      │ 14:32:10 [WARN]  Slow query detected    │
      │ 14:32:15 [ERROR] Failed to connect      │
      └──────────────────────────────────────────┘
         ↓
Actions:
  Filter by level → Update display
  Auto-scroll toggle → Enable/disable
  Tap entry → Expand details
```

---

### J7.2: Activity Feed
```
Intent: "Show recent activity"
OR
Navigation: Home → Activity tab
         ↓
View: Activity Timeline
      ┌──────────────────────────────────────────┐
      │ TODAY                                    │
      │ ──────────────────────────────────────  │
      │ 🤖 frontend: Edited 3 files     2m ago  │
      │ ✅ backend: Tests passed        5m ago  │
      │ 🔒 frontend: Permission granted 10m ago │
      │                                          │
      │ YESTERDAY                                │
      │ ──────────────────────────────────────  │
      │ 🚀 api: Deployed to production  23h ago │
      └──────────────────────────────────────────┘
         ↓
Actions:
  Tap activity → Navigate to context
  Filter by type → Update display
  Filter by project → Update display
```

---

### J7.3: Attention Dashboard
```
Intent: "What needs my attention?"
         ↓
View: Attention-First Dashboard
      ┌──────────────────────────────────────────┐
      │ NEEDS ATTENTION (3)                      │
      │ ──────────────────────────────────────  │
      │ 🔴 Permission: edit src/api.ts          │
      │    frontend • 2 min ago        [Handle] │
      │                                          │
      │ 🟡 Waiting: describe the bug            │
      │    backend • 5 min ago         [Reply]  │
      │                                          │
      │ 🔴 Error: Build failed                  │
      │    api • 10 min ago            [View]   │
      └──────────────────────────────────────────┘
         ↓
Actions:
  Handle permission → Permission dialog
  Reply to waiting → Chat view
  View error → Logs view
```

---

## Journey Category 8: Settings & Configuration

### J8.1: App Settings
```
Intent: "Open settings"
OR
Navigation: Home → Settings tab
         ↓
View: Settings Page
      - Connection settings
      - Default model selection
      - Theme preferences
      - About/Version
```

---

### J8.2: Project Settings
```
Navigation: Project → Settings tab
         ↓
View: Project Settings
      - Project name/description
      - Container tier
      - Environment variables
      - Danger zone (delete)
```

---

## Journey Category 9: Error & Recovery

### J9.1: Connection Lost
```
Any view → Connection drops
         ↓
Display: Connection banner
         ┌──────────────────────────────────────┐
         │ ⚠️ Connection lost. Reconnecting...  │
         └──────────────────────────────────────┘
         ↓
Auto-reconnect attempts
         ↓
Success → Remove banner, resume
Failure → "Unable to connect" → [Retry] [Settings]
```

---

### J9.2: Session Error
```
Chat interaction → Error occurs
         ↓
Display: Error in chat
         ┌──────────────────────────────────────┐
         │ ❌ Something went wrong              │
         │ Could not complete the request.      │
         │ [Retry] [Report Issue]               │
         └──────────────────────────────────────┘
         ↓
Actions:
  Retry → Re-send last message
  Report → Open issue dialog
```

---

### J9.3: Project Start Failed
```
Start project → Error
         ↓
Display: Error toast
         "Failed to start frontend: Container limit reached"
         ↓
Actions:
  View details → Error log
  Upgrade → Tier selection
```

---

## Journey Category 10: Advanced Flows

### J10.1: Multi-Project Monitoring
```
Intent: "Show status of all my projects"
         ↓
View: Multi-Project Dashboard
      ┌──────────────────────────────────────────┐
      │ PROJECT STATUS                           │
      │ ──────────────────────────────────────  │
      │ frontend    🟢 Running    3 sessions    │
      │ backend     🟡 Thinking   1 session     │
      │ api         ⚫ Stopped    0 sessions    │
      │ ──────────────────────────────────────  │
      │ Total: 3 projects, 4 sessions           │
      └──────────────────────────────────────────┘
```

---

### J10.2: Cross-Project Chat (Future)
```
Intent: "Fix the auth issue in frontend using the backend API"
         ↓
Detection: Multi-project context
         ↓
View: Split or linked sessions
      - frontend session (UI changes)
      - backend session (API reference)
         ↓
AI coordinates across projects
```

---

### J10.3: Batch Operations (Future)
```
Intent: "Stop all my projects"
         ↓
Confirmation: "This will stop 3 projects. Continue?"
              [frontend, backend, api]
              [Stop All] [Cancel]
         ↓
Progress: Stopping frontend... ✓
          Stopping backend... ✓
          Stopping api... ✓
         ↓
Complete: "All projects stopped"
```

---

## Journey State Machine

```
                    ┌─────────────┐
                    │   LAUNCH    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  SETUP   │ │   HOME   │ │  DEEP    │
        │ REQUIRED │ │ (intent) │ │  LINK    │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │            │            │
             ▼            ▼            ▼
        ┌──────────────────────────────────┐
        │          INTENT DETECTION         │
        └──────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ NAVIGATE │ │  ACTION  │ │  QUERY   │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │            │            │
             ▼            ▼            ▼
        ┌──────────────────────────────────┐
        │          VIEW GENERATION          │
        └──────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────┐
        │           INTERACTION             │
        │  ┌─────┐ ┌─────┐ ┌─────┐        │
        │  │Chat │ │File │ │Logs │  ...   │
        │  └─────┘ └─────┘ └─────┘        │
        └──────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ COMPLETE │ │  ERROR   │ │  INTENT  │
        │          │ │ RECOVERY │ │  (new)   │
        └──────────┘ └──────────┘ └────┬─────┘
                                       │
                                       └──── (loop back)
```

---

## Mobile-Specific Journeys

### M1: Bottom Navigation
```
Any View → Tap bottom nav item
         ↓
Items:
  Home → Intent-first home
  Projects → Projects grid
  Activity → Activity feed
  Settings → Settings page
```

### M2: Swipe Gestures
```
Project card → Swipe left → Quick actions
Session item → Swipe left → Delete
Chat → Swipe right → Open sidebar (mobile)
```

### M3: Pull to Refresh
```
Any list view → Pull down → Refresh data
```

---

## Summary: Journey Count by Category

| Category | Journey Count |
|----------|---------------|
| Getting Started | 3 |
| Intent Expression | 4 |
| Intent Detection | 8 |
| Project Management | 4 |
| Session & Chat | 7 |
| File Operations | 3 |
| Monitoring & Status | 3 |
| Settings | 2 |
| Error & Recovery | 3 |
| Advanced Flows | 3 |
| **Total** | **40** |

---

*Document created: December 2024*
