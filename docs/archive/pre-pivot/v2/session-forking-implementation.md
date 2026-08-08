# Session Forking & Branching Implementation Plan

> **Status:** In Progress  
> **Branch:** `feature/session-forking`  
> **Last Updated:** January 2026

## Overview

This document outlines the complete implementation plan for conversation branching and session forking in AgentPod. The goal is to create a Git-like mental model for AI conversations, allowing users to explore alternative approaches without losing their current progress.

---

## Table of Contents

1. [Goals & Motivation](#goals--motivation)
2. [Current State](#current-state)
3. [Architecture Design](#architecture-design)
4. [Data Model](#data-model)
5. [Backend Implementation](#backend-implementation)
6. [Frontend Implementation](#frontend-implementation)
7. [UI Components](#ui-components)
8. [Integration Points](#integration-points)
9. [Testing Strategy](#testing-strategy)
10. [Deployment Checklist](#deployment-checklist)
11. [Future Enhancements](#future-enhancements)

---

## Goals & Motivation

### User Problems Solved

1. **Exploring Alternatives**: Users want to try different approaches without losing their current conversation
2. **Comparing Outcomes**: Users need to compare how different agents/models handle the same problem
3. **Recovering from Mistakes**: Users want to "go back" to an earlier point and try again
4. **Organizing Experiments**: Users need to track and tag experimental conversations

### Key Features

- **Session Forking**: Create a new session that branches from any point in an existing conversation
- **Message Branching**: Navigate between different versions of a message (from edits/regenerations)
- **Fork Tree Visualization**: See parent-child relationships between sessions
- **Session Tags**: Organize sessions with custom tags (experiment, production, archived)
- **Session Comparison**: Side-by-side view of diverged sessions

---

## Current State

### What Exists

| Feature | Status | Location |
|---------|--------|----------|
| OpenCode `session.fork()` API | ✅ Available | `apps/api/src/services/opencode-v2.ts:390-415` |
| Fork API endpoint | ✅ Available | `POST /api/v2/sandboxes/:id/opencode/session/:sessionId/fork` |
| Tauri command | ✅ Available | `sandbox_opencode_fork_session` |
| assistant-ui branching primitives | ✅ Available | `BranchPickerPrimitive` |
| `setMessages` implementation | ⚠️ Partial | RuntimeProvider - logs only, no sync |

### What's Missing

| Feature | Status | Notes |
|---------|--------|-------|
| Fork metadata storage | ❌ Not implemented | Need DB tables |
| Session tree visualization | ❌ Not implemented | UI component needed |
| Branch picker in chat UI | ❌ Not implemented | Need to add to messages |
| Fork dialog | ❌ Not implemented | User-facing fork creation |
| Session tags | ❌ Not implemented | Organization feature |
| `setMessages` sync with OpenCode | ❌ Not implemented | Branch switching |

---

## Architecture Design

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             FRONTEND (Tauri + Svelte)                        │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────────────────────────┐ │
│  │ SessionFork  │  │ MessageBranches  │  │        UI Components           │ │
│  │   Store      │  │     Store        │  │ - SessionForkTree              │ │
│  │              │  │                  │  │ - MessageBranchPicker          │ │
│  │ - forks      │  │ - currentBranch  │  │ - ForkSessionDialog            │ │
│  │ - tree       │  │ - branches       │  │ - SessionTagsManager           │ │
│  │ - ancestry   │  │ - navigation     │  │ - SessionComparisonView        │ │
│  └──────────────┘  └──────────────────┘  └────────────────────────────────┘ │
│           │                  │                          │                    │
│           └──────────────────┴──────────────────────────┘                    │
│                              │ Tauri Commands                                │
└──────────────────────────────┼───────────────────────────────────────────────┘
                               │
┌──────────────────────────────┼───────────────────────────────────────────────┐
│                     BACKEND (Bun + Hono)                                     │
│                              │                                               │
│  ┌───────────────────────────┴───────────────────────────────────────────┐  │
│  │                     SessionForkManager                                 │  │
│  │  - createFork()      - getAncestry()      - addTag()                  │  │
│  │  - listForks()       - getChildren()      - deleteForkTree()          │  │
│  │  - recordBranch()    - getBranches()      - getRootSessions()         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                               │
│  ┌───────────────────────────┴───────────────────────────────────────────┐  │
│  │                        Database (PostgreSQL)                           │  │
│  │  ┌─────────────────────┐        ┌─────────────────────────────────┐   │  │
│  │  │   session_forks     │        │      message_branches           │   │  │
│  │  │ - id                │        │ - session_id                    │   │  │
│  │  │ - parent_session_id │        │ - branch_id                     │   │  │
│  │  │ - forked_at_msg_id  │        │ - message_id                    │   │  │
│  │  │ - fork_type         │        │ - branch_number                 │   │  │
│  │  │ - tags              │        │ - is_current                    │   │  │
│  │  └─────────────────────┘        └─────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                               │
│                              │ OpenCode SDK                                  │
└──────────────────────────────┼───────────────────────────────────────────────┘
                               │
┌──────────────────────────────┼───────────────────────────────────────────────┐
│                        OpenCode Container                                    │
│  - session.fork()                                                            │
│  - session.revert()                                                          │
│  - Manages actual conversation state                                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
User clicks "Fork from here"
         │
         ▼
┌─────────────────────┐
│  ForkSessionDialog  │
│  - Collect reason   │
│  - Confirm action   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Tauri Command      │
│  fork_session()     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐     ┌─────────────────────┐
│  API Endpoint       │────▶│  OpenCode SDK       │
│  POST /fork         │     │  session.fork()     │
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           ▼                           ▼
┌─────────────────────┐     ┌─────────────────────┐
│  SessionForkManager │     │  New OpenCode       │
│  - Store metadata   │     │  Session Created    │
│  - Record in DB     │     └─────────────────────┘
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Frontend Stores    │
│  - Update forks     │
│  - Rebuild tree     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Navigate to new    │
│  session in UI      │
└─────────────────────┘
```

---

## Data Model

### TypeScript Types

```typescript
// packages/types/src/session-fork.ts

/**
 * Metadata about a forked session
 */
export interface SessionFork {
  /** Unique fork ID (same as session ID) */
  id: string;
  
  /** Parent session ID (null for root sessions) */
  parentSessionId: string | null;
  
  /** Message ID where fork occurred (null for session start) */
  forkedAtMessageId: string | null;
  
  /** How the fork was created */
  forkType: 'explicit' | 'auto-edit' | 'auto-regenerate';
  
  /** ISO timestamp of fork creation */
  createdAt: string;
  
  /** Who created the fork */
  createdBy: 'user' | 'system';
  
  /** User-defined tags for organization */
  tags: string[];
  
  /** Additional metadata */
  metadata: {
    /** User-provided reason for forking */
    reason?: string;
    
    /** Different agent/model config if changed */
    agentConfig?: ModelSelection;
    
    /** If this fork was merged into another session */
    mergedInto?: string;
  };
}

/**
 * A branch within a session (from message edits/regenerations)
 */
export interface SessionBranch {
  /** Session this branch belongs to */
  sessionId: string;
  
  /** Unique branch identifier */
  branchId: string;
  
  /** Message where this branch starts */
  messageId: string;
  
  /** Sequential branch number (1, 2, 3...) */
  branchNumber: number;
  
  /** Parent branch if nested */
  parentBranchId: string | null;
  
  /** Is this the currently active branch */
  isCurrent: boolean;
}

/**
 * Node in the session fork tree
 */
export interface SessionTreeNode {
  /** The session */
  session: Session;
  
  /** Fork metadata (null for root sessions) */
  fork: SessionFork | null;
  
  /** Child forks */
  children: SessionTreeNode[];
  
  /** Depth in the tree (0 for root) */
  depth: number;
  
  /** Path from root (array of session IDs) */
  path: string[];
}

/**
 * Model selection for agent/model config
 */
export interface ModelSelection {
  provider: string;
  model: string;
  agent?: string;
}
```

### Database Schema

```sql
-- Session fork metadata
CREATE TABLE session_forks (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  forked_at_message_id TEXT,
  fork_type TEXT NOT NULL CHECK(fork_type IN ('explicit', 'auto-edit', 'auto-regenerate')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL CHECK(created_by IN ('user', 'system')),
  tags TEXT[] DEFAULT '{}',
  reason TEXT,
  agent_config JSONB,
  merged_into TEXT,
  
  -- Self-referential for parent
  CONSTRAINT fk_parent FOREIGN KEY (parent_session_id) 
    REFERENCES session_forks(id) ON DELETE CASCADE,
  CONSTRAINT fk_merged FOREIGN KEY (merged_into) 
    REFERENCES session_forks(id) ON DELETE SET NULL
);

-- Indexes for common queries
CREATE INDEX idx_session_forks_parent ON session_forks(parent_session_id);
CREATE INDEX idx_session_forks_tags ON session_forks USING GIN(tags);
CREATE INDEX idx_session_forks_created_at ON session_forks(created_at DESC);
CREATE INDEX idx_session_forks_fork_type ON session_forks(fork_type);

-- Message branches within a session
CREATE TABLE message_branches (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  branch_number INTEGER NOT NULL,
  parent_branch_id TEXT,
  is_current BOOLEAN DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  UNIQUE(session_id, branch_id),
  UNIQUE(session_id, message_id, branch_number)
);

CREATE INDEX idx_message_branches_session ON message_branches(session_id);
CREATE INDEX idx_message_branches_message ON message_branches(message_id);
CREATE INDEX idx_message_branches_current ON message_branches(session_id) WHERE is_current = true;
```

---

## Backend Implementation

### 1. Drizzle Schema

**Location:** `apps/api/src/db/schema/session-forks.ts`

```typescript
import { pgTable, text, timestamp, jsonb, boolean, integer, pgEnum } from 'drizzle-orm/pg-core';

export const forkTypeEnum = pgEnum('fork_type', ['explicit', 'auto-edit', 'auto-regenerate']);
export const createdByEnum = pgEnum('created_by', ['user', 'system']);

export const sessionForks = pgTable('session_forks', {
  id: text('id').primaryKey(),
  parentSessionId: text('parent_session_id'),
  forkedAtMessageId: text('forked_at_message_id'),
  forkType: forkTypeEnum('fork_type').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  createdBy: createdByEnum('created_by').notNull(),
  tags: text('tags').array().default([]),
  reason: text('reason'),
  agentConfig: jsonb('agent_config'),
  mergedInto: text('merged_into'),
});

export const messageBranches = pgTable('message_branches', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  sessionId: text('session_id').notNull(),
  branchId: text('branch_id').notNull(),
  messageId: text('message_id').notNull(),
  branchNumber: integer('branch_number').notNull(),
  parentBranchId: text('parent_branch_id'),
  isCurrent: boolean('is_current').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

### 2. SessionForkManager Service

**Location:** `apps/api/src/services/session-fork-manager.ts`

Key methods:
- `createFork()` - Create a new fork with OpenCode and store metadata
- `listForks()` - List all forks for a sandbox
- `getAncestry()` - Get path from root to a session
- `getChildren()` - Get direct child forks
- `getRootSessions()` - Get sessions with no parent
- `addTag()` / `removeTag()` - Manage session tags
- `deleteForkTree()` - Delete a fork and all descendants
- `recordBranch()` - Record message branch creation
- `getBranches()` - Get all branches in a session

### 3. API Routes

**Location:** `apps/api/src/routes/session-forks.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/:sandboxId/sessions/:sessionId/fork` | Create a fork |
| GET | `/:sandboxId/forks` | List all forks |
| GET | `/:sandboxId/sessions/:sessionId/ancestry` | Get ancestry path |
| GET | `/:sandboxId/sessions/:sessionId/children` | Get child forks |
| POST | `/:sandboxId/sessions/:sessionId/tags` | Add tag |
| DELETE | `/:sandboxId/sessions/:sessionId/tags/:tag` | Remove tag |
| DELETE | `/:sandboxId/sessions/:sessionId/tree` | Delete fork tree |
| GET | `/:sandboxId/sessions/:sessionId/branches` | Get message branches |

---

## Frontend Implementation

### 1. Tauri Commands

**Location:** `apps/frontend/src-tauri/src/commands/session_forks.rs`

| Command | Description |
|---------|-------------|
| `fork_session` | Create a session fork |
| `list_session_forks` | Get all forks for a sandbox |
| `get_session_ancestry` | Get ancestry path |
| `get_session_children` | Get child forks |
| `add_session_tag` | Add tag to session |
| `remove_session_tag` | Remove tag from session |
| `delete_fork_tree` | Delete fork and descendants |
| `list_session_branches` | Get message branches |

### 2. Frontend API Wrappers

**Location:** `apps/frontend/src/lib/api/session-forks.ts`

TypeScript wrappers around Tauri commands with proper typing.

### 3. State Management

**Location:** `apps/frontend/src/lib/stores/session-forks.svelte.ts`

Svelte 5 runes-based store managing:
- Fork metadata
- Tree structure
- Root sessions
- Tag operations
- Ancestry queries

**Location:** `apps/frontend/src/lib/stores/message-branches.svelte.ts`

Store for within-session branching:
- Current branch
- Branch list
- Navigation methods

### 4. RuntimeProvider Integration

**Location:** `apps/frontend/src/lib/chat/RuntimeProvider.tsx`

Enhanced `setMessages` callback that:
1. Finds divergence point between new and current messages
2. Calls OpenCode revert API to sync state
3. Re-fetches messages
4. Updates branch tracking

---

## UI Components

### 1. SessionForkTree

**Location:** `apps/frontend/src/lib/components/sessions/SessionForkTree.svelte`

Recursive tree component showing:
- Session hierarchy
- Current session indicator
- Fork icons
- Tags badges
- Child count
- Expand/collapse

### 2. MessageBranchPicker

**Location:** `apps/frontend/src/lib/components/chat/MessageBranchPicker.svelte`

Uses assistant-ui's `BranchPickerPrimitive`:
- Previous/Next navigation
- Branch counter (1/3)
- Hidden when single branch

### 3. ForkSessionDialog

**Location:** `apps/frontend/src/lib/components/sessions/ForkSessionDialog.svelte`

Modal for creating forks:
- Reason input
- Fork point indicator
- Cancel/Confirm buttons

### 4. MessageActions

**Location:** `apps/frontend/src/lib/components/chat/MessageActions.svelte`

Context menu with:
- Copy message
- **Fork from here** ← New
- Helpful/Not helpful feedback

### 5. SessionTagsManager

**Location:** `apps/frontend/src/lib/components/sessions/SessionTagsManager.svelte`

Tag management UI:
- List existing tags
- Add new tags
- Remove tags

### 6. SessionComparisonView

**Location:** `apps/frontend/src/lib/components/sessions/SessionComparisonView.svelte`

Side-by-side view showing:
- Two session message lists
- Divergence point highlighting
- Common messages section

---

## Integration Points

### Session Sidebar

Add view mode toggle (list/tree) to show fork relationships.

### Chat Messages

Add `MessageBranchPicker` and `MessageActions` to each message.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+B` | Show branch picker |
| `Cmd+Shift+F` | Fork from current message |
| `Cmd+[` | Previous branch |
| `Cmd+]` | Next branch |
| `Cmd+Shift+T` | Toggle session tree view |

---

## Testing Strategy

### Unit Tests

- `SessionForkManager` - All CRUD operations
- Store updates - Tree building, ancestry queries
- Type validation - Zod schemas

### Integration Tests

- API endpoints - Fork creation, tag operations
- Database operations - Foreign keys, cascading deletes
- OpenCode integration - Fork actually creates new session

### E2E Tests

- Fork from message context menu
- Branch navigation with picker
- Session tree visualization
- Tag management flow

---

## Deployment Checklist

### Phase 1: Backend Foundation (Week 1)
- [ ] Database migration
- [ ] Drizzle schema
- [ ] SessionForkManager service
- [ ] API routes
- [ ] Unit tests
- [ ] Integration tests

### Phase 2: Frontend State & API (Week 1-2)
- [ ] Tauri commands (Rust)
- [ ] API wrappers (TypeScript)
- [ ] session-forks store
- [ ] message-branches store
- [ ] Load forks on project mount

### Phase 3: UI Components (Week 2-3)
- [ ] SessionForkTree
- [ ] MessageBranchPicker
- [ ] ForkSessionDialog
- [ ] MessageActions (fork option)
- [ ] SessionTagsManager
- [ ] SessionComparisonView

### Phase 4: Integration (Week 3)
- [ ] RuntimeProvider setMessages
- [ ] SSE event handling for branches
- [ ] Session sidebar enhancement
- [ ] Keyboard shortcuts

### Phase 5: Polish (Week 4)
- [ ] E2E tests
- [ ] Performance optimization
- [ ] Error handling
- [ ] Documentation

---

## Future Enhancements

### Visual Branch Timeline

ASCII-art style timeline showing fork points and branches.

### Session Merge

Cherry-pick messages or merge entire branches.

### Session Templates

Save and reuse successful conversation patterns.

### Collaborative Forking

Share forks with team, merge insights.

### AI-Assisted Forking

Suggest fork points, auto-tag sessions.

---

## Related Documentation

- [assistant-ui Branching Guide](https://www.assistant-ui.com/docs/guides/Branching)
- [OpenCode SDK Analysis](../v1/opencode-sdk-analysis.md)
- [Shape of AI Patterns](../ui-ux/08-shape-of-ai-patterns.md) - Pattern 5.1 Footprints
- [Chat UI Refactoring Plan](../v1/chat-ui-refactoring-plan.md)

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Fork adoption rate | > 20% of active users |
| Avg forks per project | 2-3 |
| Branch navigation usage | > 50% of fork users |
| Performance (branch switch) | < 100ms |
| Data integrity | 100% (no lost forks) |

---

*Implementation started: January 2026*
