# Page Catalog

**Application:** AgentPod  
**Date:** December 2024

Comprehensive catalog of all pages/routes in the application with their components, data requirements, and current status.

---

## Table of Contents

1. [Root Layout](#1-root-layout)
2. [Home Page (Redirect)](#2-home-page-redirect)
3. [Setup Page](#3-setup-page)
4. [Settings Page](#4-settings-page)
5. [Projects List Page](#5-projects-list-page)
6. [New Project Page](#6-new-project-page)
7. [Project Detail Layout](#7-project-detail-layout)
8. [Project Index Page](#8-project-index-page)
9. [Project Chat Page](#9-project-chat-page)
10. [Project Files Page](#10-project-files-page)
11. [Project Logs Page](#11-project-logs-page)
12. [Project Sync Page](#12-project-sync-page)
13. [Project Settings Page](#13-project-settings-page)

---

## 1. Root Layout

**Route Path:** `/`  
**File Location:** `src/routes/+layout.svelte`  
**Layout Config:** `src/routes/+layout.ts`

### Purpose
The root layout wraps all pages in the application. It:
- Imports global CSS styles
- Initializes application settings (theme)
- Initializes the API connection
- Shows a loading spinner until initialization completes
- Renders the Toaster component for notifications

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Toaster` | shadcn/ui | `$lib/components/ui/sonner` |

### Data Requirements
- **Settings Store:** `initSettings()` - loads theme and preferences from local storage
- **Connection Store:** `initConnection()` - checks stored connection status and tests it

### User Interactions
- None (automatic initialization on load)

### Current State
- **Status:** Functional
- **Notes:** 
  - SSR is disabled (`ssr = false`) for Tauri compatibility
  - All pages are prerendered (`prerender = true`)

---

## 2. Home Page (Redirect)

**Route Path:** `/`  
**File Location:** `src/routes/+page.svelte`

### Purpose
Acts as a routing gateway that redirects users based on connection status:
- If connected to API → redirect to `/projects`
- If not connected → redirect to `/setup`

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| Loading spinner | Custom CSS | Inline styles |

### Data Requirements
- **Connection Store:** `connection.isConnected` - determines redirect destination

### User Interactions
- None (automatic redirect)

### Current State
- **Status:** Functional (to be replaced with Dashboard)
- **Notes:** Uses both `onMount` for initial redirect and `$effect` for reactive changes

---

## 3. Setup Page

**Route Path:** `/setup`  
**File Location:** `src/routes/setup/+page.svelte`

### Purpose
The initial setup/connection page where users configure their connection to the Management API. This is the entry point for new users.

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Input` | shadcn/ui | `$lib/components/ui/input` |
| `Label` | shadcn/ui | `$lib/components/ui/label` |
| `Card.*` | shadcn/ui | `$lib/components/ui/card` |

### Data Requirements
- **Connection Store:** `connection.isConnected` - for auto-redirect if already connected
- **Connection Functions:** `connect(apiUrl, apiKey)` - to establish connection

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Enter API URL | Form input | Required field for Management API endpoint |
| Enter API Key | Form input | Optional authentication key |
| Submit form | `handleConnect()` | Tests and establishes connection |

### Current State
- **Status:** Functional
- **Notes:** 
  - Version displayed as "v0.1.0" (hardcoded)
  - Error messages displayed inline in the form

---

## 4. Settings Page

**Route Path:** `/settings`  
**File Location:** `src/routes/settings/+page.svelte`

### Purpose
Comprehensive settings management page with multiple sections:
1. Connection management
2. Appearance/Theme settings
3. LLM Provider configuration
4. OpenCode Permissions
5. Global Instructions (AGENTS.md)
6. Custom Agents & Commands management
7. Preferences (notifications, auto-refresh)
8. Backup & Restore
9. Application info
10. Statistics overview

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Input` | shadcn/ui | `$lib/components/ui/input` |
| `Label` | shadcn/ui | `$lib/components/ui/label` |
| `Switch` | shadcn/ui | `$lib/components/ui/switch` |
| `Card.*` | shadcn/ui | `$lib/components/ui/card` |
| `Select.*` | shadcn/ui | `$lib/components/ui/select` |
| `Tabs.*` | shadcn/ui | `$lib/components/ui/tabs` |
| `Dialog.*` | shadcn/ui | `$lib/components/ui/dialog` |
| `LlmProviderSelector` | Custom | `$lib/components/llm-provider-selector.svelte` |

### Data Requirements
- **Connection Store:** API URL, connection status, error messages
- **Projects Store:** Project statistics (total, running, stopped, errored)
- **Settings Store:** Theme, default provider, auto-refresh, notifications
- **OpenCode Config:** Permissions, AGENTS.md, config files

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Test Connection | `handleTestConnection()` | Verifies API connectivity |
| Disconnect | `handleDisconnect()` | Clears connection and returns to setup |
| Change Theme | `handleThemeChange()` | Switches between light/dark/system |
| Change Provider | `handleProviderChange()` | Sets default LLM provider |
| Export Settings | `handleExport()` | Downloads settings as JSON |
| Import Settings | `handleImport()` | Uploads settings from JSON |
| Reset Settings | `handleReset()` | Restores defaults |
| Edit Permissions | `handlePermissionChange()` | Modifies tool permission levels |
| Save AGENTS.md | `handleSaveAgentsMd()` | Saves global instructions |
| Create/Edit/Delete Files | Multiple handlers | Manages custom agents, commands, tools, plugins |
| Toggle Notifications | Switch handlers | Enables/disables in-app and system notifications |

### Current State
- **Status:** Functional and feature-complete
- **Issues:** Version hardcoded as "0.1.0"
- **Notes:** Uses Tauri's notification plugin for system notifications

---

## 5. Projects List Page

**Route Path:** `/projects`  
**File Location:** `src/routes/projects/+page.svelte`

### Purpose
Displays all user projects in a grid layout with status indicators and quick actions.

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Card.*` | shadcn/ui | `$lib/components/ui/card` |
| `Badge` | shadcn/ui | `$lib/components/ui/badge` |
| `Skeleton` | shadcn/ui | `$lib/components/ui/skeleton` |

### Data Requirements
- **Connection Store:** `connection.isConnected`, `connection.apiUrl`
- **Projects Store:** `projects.list`, `projects.isLoading`, `projects.error`

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Click Project Card | `handleProjectClick()` | Navigates to `/projects/[id]` |
| New Project | Navigation | Goes to `/projects/new` |
| Settings | Navigation | Goes to `/settings` |
| Start Project | `startProject(id)` | Starts a stopped project |
| Stop Project | `stopProject(id)` | Stops a running project |
| Delete Project | `deleteProject(id)` | Removes project with confirmation |

### Current State
- **Status:** Functional
- **Notes:**
  - Uses responsive grid: 1 column (mobile), 2 columns (tablet), 3 columns (desktop)
  - Project cards are clickable with button actions having stopPropagation
  - Status badge colors: running=green, stopped=secondary, error=red, creating=outline

---

## 6. New Project Page

**Route Path:** `/projects/new`  
**File Location:** `src/routes/projects/new/+page.svelte`

### Purpose
Form for creating new projects with two modes:
1. **From Scratch** - Create a new empty project
2. **Import from GitHub** - Clone an existing repository

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Input` | shadcn/ui | `$lib/components/ui/input` |
| `Label` | shadcn/ui | `$lib/components/ui/label` |
| `Card.*` | shadcn/ui | `$lib/components/ui/card` |
| `Tabs.*` | shadcn/ui | `$lib/components/ui/tabs` |
| `LlmProviderSelector` | Custom | `$lib/components/llm-provider-selector.svelte` |
| `TierSelector` | Custom | `$lib/components/tier-selector.svelte` |

### Data Requirements
- **Connection Store:** `connection.isConnected` for redirect
- **Projects Store:** `createProject()` function

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Switch Tab | `activeTab` binding | Toggles between "scratch" and "github" |
| Enter Project Name | Input binding | Required for "from scratch" mode |
| Enter Description | Input binding | Optional project description |
| Enter GitHub URL | Input binding | Required for "import" mode |
| Toggle GitHub Sync | Checkbox binding | Enable/disable sync |
| Select LLM Provider/Model | `LlmProviderSelector` | Choose AI model |
| Select Container Tier | `TierSelector` | Choose resource allocation |
| Submit | `handleSubmit()` | Creates the project |
| Cancel | `handleCancel()` | Returns to projects list |

### Current State
- **Status:** Functional
- **Notes:**
  - Shows creation progress with step indicators
  - Extracts repo name from GitHub URL automatically
  - Validation: name required for scratch, valid URL for GitHub import

---

## 7. Project Detail Layout

**Route Path:** `/projects/[id]`  
**File Location:** `src/routes/projects/[id]/+layout.svelte`

### Purpose
Shared layout for all project detail pages. Provides:
- Project header with name, status, and actions
- Tab navigation between sub-pages
- Deploy functionality with confirmation dialog

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Badge` | shadcn/ui | `$lib/components/ui/badge` |
| `Tabs.*` | shadcn/ui | `$lib/components/ui/tabs` |
| `Dialog.*` | shadcn/ui | `$lib/components/ui/dialog` |

### Data Requirements
- **Route Params:** `$page.params.id` - project ID
- **Projects Store:** `getProject(id)`, `fetchProjects()`
- **Connection Store:** `connection.isConnected`

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Back to Projects | Navigation | Returns to `/projects` |
| Start Project | `startProject(id)` | Start stopped project |
| Stop Project | `stopProject(id)` | Stop running project |
| Deploy | `handleDeploy()` | Opens deploy confirmation |
| Force Deploy | `handleDeploy(true)` | Forces container rebuild |
| Tab Navigation | `handleTabChange()` | Switches between tabs |

### Current State
- **Status:** Functional
- **Notes:**
  - Tabs: Chat, Files, Logs, Sync, Settings
  - Shows loading state while project data loads
  - "Project not found" fallback for invalid IDs

---

## 8. Project Index Page

**Route Path:** `/projects/[id]`  
**File Location:** `src/routes/projects/[id]/+page.svelte`

### Purpose
Simple redirect page - automatically redirects to the Chat tab.

### UI Components Used
None (just a redirect message)

### Data Requirements
- **Route Params:** `$page.params.id`

### User Interactions
- None (automatic redirect)

### Current State
- **Status:** Functional
- **Notes:** Uses `replaceState: true` to avoid browser history pollution

---

## 9. Project Chat Page

**Route Path:** `/projects/[id]/chat`  
**File Location:** `src/routes/projects/[id]/chat/+page.svelte`

### Purpose
The main AI chat interface for interacting with OpenCode. Features:
- Session management (create, select, delete)
- Real-time chat with AI models
- File picker for referencing project files
- Model selection per chat

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Skeleton` | shadcn/ui | `$lib/components/ui/skeleton` |
| `RuntimeProvider` | React (wrapped) | `$lib/chat/RuntimeProvider` |
| `ChatThread` | React (wrapped) | `$lib/chat/ChatThread` |
| `FilePickerModal` | Custom | `$lib/components/file-picker-modal.svelte` |
| `ModelSelector` | Custom | `$lib/components/model-selector.svelte` |

### Data Requirements
- **Route Params:** `$page.params.id` - project ID
- **OpenCode API:** Sessions, messages, files
- **URL Params:** `?file=` - optional file to reference from Files page

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Create Session | `createNewSession()` | Starts new chat session |
| Select Session | Click session item | Switches active session |
| Delete Session | Click delete button | Removes session with confirmation |
| Refresh Sessions | `loadSessions()` | Reloads session list |
| Select Model | `ModelSelector` | Choose LLM for messages |
| Open File Picker | `handleFilePickerRequest()` | Opens modal for file selection |
| Send Message | `ChatThread` (React) | Submit message to AI |

### Current State
- **Status:** Functional
- **Notes:**
  - Uses React components (svelte-preprocess-react) for chat UI
  - Session sidebar on left, chat area on right
  - Model selection persists per session
  - Supports file attachments via URL param or picker

---

## 10. Project Files Page

**Route Path:** `/projects/[id]/files`  
**File Location:** `src/routes/projects/[id]/files/+page.svelte`

### Purpose
File browser for viewing project files. Features:
- Tree view of project structure
- Lazy-loaded folder contents
- Syntax-highlighted code preview
- Markdown preview mode
- File actions (copy path, copy content, use in chat)

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Card.*` | shadcn/ui | `$lib/components/ui/card` |
| `Skeleton` | shadcn/ui | `$lib/components/ui/skeleton` |
| `ScrollArea` | shadcn/ui | `$lib/components/ui/scroll-area` |
| `CodeBlock` | Custom | `$lib/components/ui/code-block` |
| `MarkdownViewer` | Custom | `$lib/components/ui/markdown` |

### Data Requirements
- **Route Params:** `$page.params.id` - project ID
- **OpenCode API:** `opencodeListFiles()`, `opencodeGetFileContent()`

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Expand/Collapse Folder | `toggleFolder()` | Lazy loads and toggles folders |
| Select File | `selectFile()` | Shows file content in viewer |
| Copy Path | `copyPath()` | Copies file path to clipboard |
| Copy Content | Click button | Copies file content to clipboard |
| Use in Chat | `useInChat()` | Navigates to chat with file param |
| Toggle Markdown View | Click Raw/Preview | Switches between raw and rendered |
| Refresh | `loadFileTree()` | Reloads file tree |

### Current State
- **Status:** Functional
- **Notes:**
  - File icons by extension (TypeScript, JavaScript, Svelte, Rust, etc.)
  - Base64 decoding for file content from API
  - Lazy loading prevents loading entire tree at once

---

## 11. Project Logs Page

**Route Path:** `/projects/[id]/logs`  
**File Location:** `src/routes/projects/[id]/logs/+page.svelte`

### Purpose
View container stdout/stderr logs with configurable line count and auto-refresh.

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Card.*` | shadcn/ui | `$lib/components/ui/card` |
| `Label` | shadcn/ui | `$lib/components/ui/label` |
| `Input` | shadcn/ui | `$lib/components/ui/input` |
| `ScrollArea` | shadcn/ui | `$lib/components/ui/scroll-area` |
| `CodeBlock` | Custom | `$lib/components/ui/code-block` |

### Data Requirements
- **Route Params:** `$page.params.id` - project ID
- **API:** `getProjectLogs(id, lines)` - fetch container logs

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Change Lines | `handleLinesChange()` | Adjust number of lines (1-1000) |
| Refresh | `loadLogs()` | Manually refresh logs |
| Toggle Auto-refresh | Click button | Enable/disable 5-second auto-refresh |

### Current State
- **Status:** Functional
- **Notes:**
  - Default: 100 lines
  - Auto-refresh interval: 5 seconds
  - Shows line count in header

---

## 12. Project Sync Page

**Route Path:** `/projects/[id]/sync`  
**File Location:** `src/routes/projects/[id]/sync/+page.svelte`

### Purpose
Configure GitHub synchronization settings for the project.

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Card.*` | shadcn/ui | `$lib/components/ui/card` |

### Data Requirements
- **Route Params:** `$page.params.id` - project ID

### User Interactions
- None currently (placeholder page)

### Current State
- **Status:** INCOMPLETE - Placeholder only
- **Issues:**
  - No actual sync functionality implemented
  - Just displays "Sync settings coming soon."
- **Notes:**
  - The `Project` type has fields for sync: `githubRepoUrl`, `githubSyncEnabled`, `githubSyncDirection`, `lastSyncAt`

---

## 13. Project Settings Page

**Route Path:** `/projects/[id]/settings`  
**File Location:** `src/routes/projects/[id]/settings/+page.svelte`

### Purpose
Project-specific settings showing:
- Service URLs (OpenCode API, Code Server, VNC)
- Service health status
- Container information
- Quick action buttons

### UI Components Used

| Component | Type | Source |
|-----------|------|--------|
| `Button` | shadcn/ui | `$lib/components/ui/button` |
| `Badge` | shadcn/ui | `$lib/components/ui/badge` |

### Data Requirements
- **Route Params:** `$page.params.id` - project ID
- **Projects Store:** `getProject(id)` - project data including URLs
- **API:** `opencodeHealthCheck()` - check service health

### User Interactions

| Action | Handler | Description |
|--------|---------|-------------|
| Open OpenCode | `openService()` | Opens in-app or browser window |
| Open Code Server | `openService()` | Opens VS Code in browser |
| Open Desktop (VNC) | `openService()` | Opens desktop environment |
| Refresh Health | `checkHealth()` | Re-checks service health status |

### Current State
- **Status:** Mostly functional
- **Notes:**
  - Health check only available when project is running
  - VNC section only shows for desktop-tier containers
  - Uses `openServiceWindow()` utility for in-app windows

---

## Summary Table

| Route | Status | Components | Key Features |
|-------|--------|------------|--------------|
| `/` | Functional | 1 | Auto-redirect based on connection |
| `/setup` | Functional | 6 | API connection form |
| `/settings` | Functional | 10+ | Full settings management |
| `/projects` | Functional | 4 | Project list with actions |
| `/projects/new` | Functional | 7 | Create/import projects |
| `/projects/[id]` | Functional | 4 | Project detail layout |
| `/projects/[id]/chat` | Functional | 6 | AI chat interface |
| `/projects/[id]/files` | Functional | 6 | File browser |
| `/projects/[id]/logs` | Functional | 6 | Container logs |
| `/projects/[id]/sync` | INCOMPLETE | 2 | Placeholder only |
| `/projects/[id]/settings` | Functional | 2 | Project info & health |

---

## Custom Components Used Across Pages

| Component | Location | Used In |
|-----------|----------|---------|
| `LlmProviderSelector` | `$lib/components/llm-provider-selector.svelte` | Settings, New Project |
| `TierSelector` | `$lib/components/tier-selector.svelte` | New Project |
| `FilePickerModal` | `$lib/components/file-picker-modal.svelte` | Chat |
| `ModelSelector` | `$lib/components/model-selector.svelte` | Chat |
| `CodeBlock` | `$lib/components/ui/code-block` | Files, Logs |
| `MarkdownViewer` | `$lib/components/ui/markdown` | Files |

---

## Shared Stores

| Store | Location | Purpose |
|-------|----------|---------|
| `connection` | `$lib/stores/connection.svelte.ts` | API connection state |
| `projects` | `$lib/stores/projects.svelte.ts` | Projects CRUD and state |
| `settings` | `$lib/stores/settings.svelte.ts` | App preferences |

---

*Document generated: December 2024*
