# User Journey

Detailed user flows and interactions for the Portable Command Center mobile application.

---

## Table of Contents

- [Personas](#personas)
- [User Journeys](#user-journeys)
  - [First-Time Setup](#first-time-setup)
  - [Create New Project (From Scratch)](#create-new-project-from-scratch)
  - [Import Project from GitHub](#import-project-from-github)
  - [Work on Existing Project](#work-on-existing-project)
  - [Browse and View Files](#browse-and-view-files)
  - [Configure LLM Provider](#configure-llm-provider)
  - [Sync Changes to GitHub](#sync-changes-to-github)
  - [Monitor Background Tasks](#monitor-background-tasks)
- [Screen Flows](#screen-flows)
- [Edge Cases](#edge-cases)

---

## Personas

### Primary User: Solo Developer / Founder

- **Name**: Alex
- **Role**: One-person company founder
- **Goal**: Manage AI-assisted development from anywhere
- **Context**: Uses phone during commute, lunch breaks, or when away from desk
- **Technical Level**: Comfortable with Git, APIs, and command line

### Usage Patterns

| Scenario | Duration | Actions |
|----------|----------|---------|
| Quick check | 1-2 min | Check task status, review AI output |
| Code review | 5-10 min | Review changes, approve/reject, give feedback |
| Start task | 2-5 min | Create session, describe task, let AI work |
| Project setup | 10-15 min | Create project, configure, initial prompt |

---

## User Journeys

### First-Time Setup

**Goal**: Connect mobile app to infrastructure and configure first LLM provider.

```mermaid
flowchart TD
    A[Launch App] --> B{Config exists?}
    B -->|No| C[Welcome Screen]
    B -->|Yes| Z[Projects List]
    
    C --> D[Enter API URL]
    D --> E{Tailscale<br/>connected?}
    E -->|No| F[Prompt to enable]
    F --> E
    E -->|Yes| G[Connection successful]
    
    G --> H[Enter API Token]
    H --> I[Token stored in Keychain]
    
    I --> J[Select LLM Provider]
    J --> K{Provider type?}
    
    K -->|API Key| L[Enter API Key]
    L --> M[Key stored in Coolify]
    
    K -->|OAuth| N[Initiate OAuth]
    N --> O[Open Browser]
    O --> P[User authenticates]
    P --> Q[Token returned]
    
    M --> R[Setup Complete]
    Q --> R
    R --> Z
```

**Screens:**
1. Welcome / Onboarding
2. Connect to Server
3. Authentication
4. LLM Provider Selection
5. API Key Entry / OAuth Flow
6. Setup Complete

---

### Create New Project (From Scratch)

**Goal**: Create a new empty project and start working with OpenCode.

```mermaid
flowchart TD
    A[Tap 'New Project'] --> B[Modal: Choose type]
    B -->|From scratch| C[Project form]
    B -->|Import| D[See Import flow]
    
    C --> E[Enter name & description]
    E --> F[Select LLM provider]
    F --> G[Tap 'Create']
    
    G --> H[Creating repo in Forgejo...]
    H --> I[Setting up container...]
    I --> J[Configuring environment...]
    J --> K[Starting OpenCode...]
    
    K --> L[Project Ready]
    L --> M[Chat View]
```

**Background Actions (Management API):**

```mermaid
sequenceDiagram
    participant App as Mobile App
    participant Mgmt as Management API
    participant FG as Forgejo
    participant CL as Coolify
    participant OC as OpenCode
    
    App->>Mgmt: POST /projects (name, provider)
    Mgmt->>FG: Create repository
    FG-->>Mgmt: Repo URL
    Mgmt->>CL: Create Docker app
    Mgmt->>CL: Set env vars (LLM keys, repo URL)
    Mgmt->>CL: Start container
    CL->>OC: Container starts
    OC->>FG: Git clone
    OC-->>OC: Start server
    Mgmt-->>App: Project ready
```

**Screens:**
1. Projects List → New Project Modal
2. Project Creation Form
3. Creation Progress
4. Project Chat (empty)

---

### Import Project from GitHub

**Goal**: Import an existing GitHub repository into Forgejo and set up OpenCode.

```mermaid
flowchart TD
    A[Tap 'Import from GitHub'] --> B[Enter repo URL]
    B --> C{Valid URL?}
    C -->|No| B
    C -->|Yes| D[Auto-detect provider]
    
    D --> E[Configure import]
    E --> F[Set project name]
    F --> G[Select LLM provider]
    G --> H{Enable sync?}
    
    H -->|Yes| I[Configure sync direction]
    H -->|No| J{Private repo?}
    I --> J
    
    J -->|Yes| K[GitHub OAuth]
    K --> L[Grant access]
    J -->|No| M[Tap 'Import']
    L --> M
    
    M --> N[Cloning repository...]
    N --> O[Creating Forgejo mirror...]
    O --> P[Setting up container...]
    P --> Q[Analyzing project...]
    
    Q --> R[Project Ready]
    R --> S[Chat with analysis]
```

**Background Actions (Management API):**

```mermaid
sequenceDiagram
    participant App as Mobile App
    participant Mgmt as Management API
    participant GH as GitHub
    participant FG as Forgejo
    participant CL as Coolify
    participant OC as OpenCode
    
    App->>Mgmt: POST /projects (github_url)
    Mgmt->>GH: Clone repo
    Mgmt->>FG: Create repo + push content
    Mgmt->>Mgmt: Store GitHub credentials
    Mgmt->>CL: Create Docker app
    Mgmt->>CL: Set env vars
    Mgmt->>CL: Start container
    CL->>OC: Container starts
    OC->>FG: Git clone
    OC->>OC: Run /init (analyze)
    Mgmt-->>App: Project ready
```

**Screens:**
1. New Project Modal → Import Tab
2. Repository URL Input
3. Import Configuration
4. GitHub OAuth (if needed)
5. Import Progress
6. Project Chat (with analysis)

---

### Work on Existing Project

**Goal**: Open a project and interact with OpenCode to make changes.

```mermaid
flowchart TD
    A[Open App] --> B[Projects List]
    B --> C{Select project}
    
    C --> D{Container status?}
    D -->|Stopped| E[Prompt: Start?]
    E -->|Yes| F[Starting...]
    E -->|No| B
    F --> G[Chat View]
    D -->|Running| G
    
    G --> H[View sessions]
    H --> I{Action?}
    I -->|New session| J[Chat input]
    I -->|Continue| J
    
    J --> K[Type prompt]
    K --> L[Send]
    L --> M[Thinking...]
    M --> N[Stream response]
    
    N --> O{Permission needed?}
    O -->|Yes| P[Permission modal]
    P -->|Allow| Q[Execute action]
    P -->|Deny| N
    O -->|No| Q
    
    Q --> R[View changes]
    R --> S{More work?}
    S -->|Yes| J
    S -->|No| T[Done]
```

**Project Status Indicators:**
- 🟢 Running (container active)
- 🟡 Starting (container booting)  
- 🔴 Stopped (container off)
- ⚪ Unknown (no connection)

**Screens:**
1. Projects List
2. Project Chat (sessions list)
3. Active Chat Session
4. Permission Request Modal
5. Changes Diff View

---

### Browse and View Files

**Goal**: Browse project structure and view file contents.

```
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSE AND VIEW FILES                        │
└─────────────────────────────────────────────────────────────────┘

1. OPEN PROJECT → TAP "FILES" TAB
   └─► File browser shows project structure:
       📁 src/
       📁 docs/
       📁 tests/
       📄 package.json
       📄 README.md
       📄 .gitignore

2. NAVIGATE FOLDERS
   ├─► Tap folder to expand/collapse
   ├─► Breadcrumb navigation at top: project / src / components
   └─► Back button or swipe to go up

3. TAP FILE TO VIEW
   └─► File viewer opens with:
       ├─► Syntax highlighting (based on file type)
       ├─► Line numbers
       ├─► File path in header
       └─► File size and last modified info

4. FILE VIEWER ACTIONS
   ├─► 🔍 Search within file (Cmd+F / Ctrl+F)
   ├─► 📋 Copy file path
   ├─► 📤 Share file content
   ├─► 💬 "Ask about this file" → Opens chat with file context
   └─► ✏️ "Edit with AI" → Opens chat with edit prompt

5. REFERENCE FILE IN CHAT
   ├─► From file viewer: Tap "Use in Chat"
   ├─► From chat: Type @ to open file picker
   │   └─► Search or browse to select file
   └─► File reference appears as: @src/components/Button.svelte

6. VIEW RECENT CHANGES
   ├─► Tap "History" icon on file
   └─► Shows recent commits affecting this file:
       • "Add hover state" - 2 hours ago
       • "Initial component" - yesterday
       └─► Tap commit to see diff

   DATA SOURCE (OpenCode API):
   ├─► GET /file - Read file contents
   ├─► GET /find - Search/list files
   └─► GET /file/status - Git status for files
```

**Screens:**
1. Project View → Files Tab
2. File Browser (tree view)
3. File Viewer (with syntax highlighting)
4. File Search
5. File History / Git Log
6. File Reference Picker (in chat)

**Supported File Types:**
| Type | Extensions | Features |
|------|------------|----------|
| Code | .js, .ts, .py, .go, .rs, .svelte | Syntax highlighting, line numbers |
| Markup | .html, .md, .mdx | Rendered preview option |
| Config | .json, .yaml, .toml | Syntax highlighting |
| Text | .txt, .log | Plain text view |
| Images | .png, .jpg, .svg | Image preview |
| Binary | Others | "Cannot preview" message, download option |

---

### Configure LLM Provider

**Goal**: Add or change LLM provider credentials.

```
┌─────────────────────────────────────────────────────────────────┐
│                   CONFIGURE LLM PROVIDER                        │
└─────────────────────────────────────────────────────────────────┘

1. OPEN SETTINGS → "LLM PROVIDERS"
   └─► List of configured providers:
       • OpenRouter ✓ (default)
       • Anthropic ✓
       • GitHub Copilot (not configured)
       • + Add Provider

2. TAP PROVIDER TO CONFIGURE

   ─────────────────────────────────────────
   FLOW A: API KEY PROVIDER (OpenRouter, OpenAI, etc.)
   ─────────────────────────────────────────

   2a. TAP "OpenRouter" or "Add Provider"
       └─► Provider config screen

   3a. ENTER API KEY
       ├─► Input field for API key
       ├─► "Get API Key" link to provider's website
       └─► Tap "Save"

   4a. VALIDATION
       ├─► App tests key with provider API
       ├─► Success: "Provider configured ✓"
       └─► Failure: "Invalid API key"

   ─────────────────────────────────────────
   FLOW B: OAUTH PROVIDER (GitHub Copilot)
   ─────────────────────────────────────────

   2b. TAP "GitHub Copilot"
       └─► Provider config screen shows "Authenticate with GitHub"

   3b. TAP "AUTHENTICATE"
       ├─► App generates device code via OAuth proxy
       └─► Shows:
           "Enter code: 8F43-6FCF"
           "at github.com/login/device"
           [Open Browser]

   4b. USER AUTHENTICATES
       ├─► Opens browser (in-app or external)
       ├─► Enters code on GitHub
       ├─► Grants Copilot access
       └─► Returns to app

   5b. APP POLLS FOR TOKEN
       ├─► OAuth proxy polls GitHub
       ├─► Token received
       └─► "GitHub Copilot configured ✓"

   ─────────────────────────────────────────
   FLOW C: OAUTH PROVIDER (Anthropic Claude Pro/Max)
   ─────────────────────────────────────────

   2c. TAP "Anthropic" → "Claude Pro/Max"
       └─► Shows auth options:
           • "API Key" (manual)
           • "Claude Pro/Max" (OAuth)

   3c. TAP "CLAUDE PRO/MAX"
       ├─► App opens Anthropic OAuth URL
       └─► User authenticates in browser

   4c. CALLBACK
       ├─► Anthropic redirects to app deep link
       ├─► App extracts token
       └─► "Anthropic Claude Pro configured ✓"

3. SET DEFAULT PROVIDER
   ├─► Tap star icon next to provider
   └─► "Default provider: OpenRouter"

4. PER-PROJECT OVERRIDE
   ├─► In project settings
   └─► "LLM Provider" dropdown shows all configured providers
```

**Screens:**
1. Settings → LLM Providers
2. Provider Configuration
3. API Key Input
4. OAuth Device Code Display
5. OAuth Browser (WebView or external)
6. Success Confirmation

---

### Sync Changes to GitHub

**Goal**: Push changes made by OpenCode back to the original GitHub repository.

```
┌─────────────────────────────────────────────────────────────────┐
│                    SYNC TO GITHUB                               │
└─────────────────────────────────────────────────────────────────┘

1. OPEN PROJECT → "SYNC" BUTTON
   └─► Sync status panel shows:
       • Last sync: 2 hours ago
       • Local changes: 5 commits ahead
       • Remote changes: 0 commits behind

2. TAP "PUSH TO GITHUB"
   ├─► Confirmation: "Push 5 commits to GitHub?"
   │   Shows commit messages preview
   └─► User confirms

3. SYNC IN PROGRESS
   ├─► "Pushing changes..."
   ├─► Progress indicator
   └─► If conflict:
       ├─► "Conflict detected"
       ├─► Options:
       │   • "Pull and merge"
       │   • "Force push" (overwrites remote)
       │   • "Cancel"
       └─► User selects resolution

4. SYNC COMPLETE
   └─► "Successfully synced to GitHub ✓"
       "5 commits pushed"

   BACKGROUND ACTIONS (Management API):
   ├─► Fetch latest from Forgejo
   ├─► Push to GitHub using stored credentials
   └─► Update sync status in database
```

**Screens:**
1. Project View → Sync Panel
2. Sync Confirmation
3. Sync Progress
4. Conflict Resolution (if needed)
5. Sync Complete

---

### Monitor Background Tasks

**Goal**: Check on tasks running while away from the app.

```
┌─────────────────────────────────────────────────────────────────┐
│                   MONITOR BACKGROUND TASKS                      │
└─────────────────────────────────────────────────────────────────┘

1. RECEIVE PUSH NOTIFICATION
   └─► "✅ my-awesome-app: Task complete"
       OR
       "⚠️ my-awesome-app: Needs input"

2. TAP NOTIFICATION
   └─► App opens directly to relevant session

3. REVIEW RESULTS
   ├─► See complete chat history
   ├─► Review all changes made
   └─► Continue conversation if needed

4. ALTERNATIVE: OPEN APP MANUALLY
   └─► Dashboard shows:
       ├─► Active tasks (with live status)
       ├─► Completed tasks (last 24h)
       └─► Tasks needing attention
           • Permission requests
           • Errors
           • Questions from AI
```

**Screens:**
1. Push Notification (OS)
2. Dashboard with task status
3. Session view with results

---

## Screen Flows

### Main Navigation

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐         │
│  │Projects │   │ Servers │   │Activity │   │Settings │         │
│  │  List   │   │ Status  │   │  Feed   │   │         │         │
│  └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘         │
│       │             │             │             │               │
│       ▼             ▼             ▼             ▼               │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐         │
│  │ Project │   │ Server  │   │ Session │   │  LLM    │         │
│  │  View   │   │ Detail  │   │ Detail  │   │Providers│         │
│  └────┬────┘   └─────────┘   └─────────┘   └─────────┘         │
│       │                                                         │
│  ┌────┴─────────────────────────────┐                           │
│  │                                  │                           │
│  ▼                                  ▼                           │
│  ┌─────────┐                   ┌─────────┐                      │
│  │  Chat   │                   │  Files  │                      │
│  │Sessions │                   │ Browser │                      │
│  └────┬────┘                   └────┬────┘                      │
│       │                             │                           │
│       ▼                             ▼                           │
│  ┌─────────┐                   ┌─────────┐                      │
│  │ Session │                   │  File   │                      │
│  │Messages │                   │ Viewer  │                      │
│  └─────────┘                   └─────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Project View Tabs

```
┌─────────────────────────────────────────────────────────────────┐
│                         PROJECT VIEW                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ < Back    my-awesome-app                    ⚙️ ↗️ 🔄    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  [ 💬 Chat ]    [ 📁 Files ]    [ 🔄 Sync ]             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│                    (Tab content below)                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Project Chat Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         PROJECT CHAT                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ < Back    my-awesome-app                    ⚙️ ↗️ 🔄    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Sessions                                                │    │
│  │ ┌─────────────────────────────────────────────────────┐ │    │
│  │ │ Today                                               │ │    │
│  │ │ • Add user authentication          🟢 Complete     │ │    │
│  │ │ • Fix database connection          🟢 Complete     │ │    │
│  │ │                                                     │ │    │
│  │ │ Yesterday                                           │ │    │
│  │ │ • Set up project structure         🟢 Complete     │ │    │
│  │ └─────────────────────────────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ + New Session                                           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ What would you like to work on?                    📎  │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Edge Cases

### No Network Connection

```
User opens app → No Tailscale connection
├─► Show cached project list (read-only)
├─► Display "Offline" banner
├─► Queue any actions for when online
└─► Retry connection in background
```

### Container Crashed

```
User opens project → Container not responding
├─► Show error: "Project unavailable"
├─► Options:
│   • "Restart" (attempts container restart)
│   • "View Logs" (fetch recent logs)
│   • "Contact Support"
└─► Auto-retry with exponential backoff
```

### OAuth Token Expired

```
User sends prompt → 401 Unauthorized
├─► Detect token expiration
├─► Prompt: "Session expired. Re-authenticate?"
├─► Re-run OAuth flow
└─► Retry original request
```

### Forgejo/GitHub Sync Conflict

```
User pushes to GitHub → Conflict
├─► Show conflict details
├─► Options:
│   • View conflicting changes
│   • Pull latest first
│   • Force push (override)
│   • Cancel and resolve manually
└─► Guide user through resolution
```

### Long-Running Task

```
User starts complex task → Takes > 5 minutes
├─► Show progress indicator
├─► "This may take a while. You can close the app."
├─► Background task continues on server
├─► Push notification when done
└─► Deep link brings user back to results
```

---

*Document created: December 2024*
*Last updated: December 2024*
