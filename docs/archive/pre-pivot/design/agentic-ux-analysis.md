# Agentic AI UX Analysis Report

**Application:** AgentPod "Portable Command Center"  
**Date:** December 2024  
**Focus:** AI Agent Management UX Patterns

---

## Executive Summary

AgentPod is a Tauri + Svelte app that serves as a remote interface for AI coding agents (OpenCode) running on cloud infrastructure. The codebase demonstrates **foundational agentic UX patterns** but has significant gaps compared to best practices for this paradigm. The app handles basic chat interaction and permission requests but lacks the sophisticated transparency, control, and trust-building features essential for remote AI agent management.

---

## 1. Current Agentic UX Patterns Found (What's Working)

### 1.1 Permission System (Human-in-the-Loop)

**Location:** `src/lib/chat/PermissionContext.tsx`, `PermissionBar.tsx`

**Strengths:**
- Permission requests queue properly (FIFO handling)
- Three-option response model: "Allow Once", "Always Allow", "Reject"
- Visual distinction by permission type (bash, file edit, web fetch, directory)
- Loading states during permission response
- Sticky bar at bottom of chat for visibility

**Code Evidence:**
```tsx
// PermissionBar.tsx - Good progressive permission options
<button onClick={() => handleRespond("reject")}>Reject</button>
<button onClick={() => handleRespond("always")}>Always Allow</button>
<button onClick={() => handleRespond("once")}>Allow Once</button>
```

### 1.2 Tool Call Visibility

**Location:** `src/lib/chat/ChatThread.tsx`

**Strengths:**
- Tool calls display with status indicators (pending → running → completed)
- Collapsible details showing arguments and results
- Visual grouping of consecutive tool calls

**Code Evidence:**
```tsx
// ToolCallPart - Shows tool status
<span className={`w-2 h-2 rounded-full ${isComplete ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} />
<span>{isComplete ? 'completed' : 'running...'}</span>
```

### 1.3 Session Persistence

**Location:** `src/routes/projects/[id]/chat/+page.svelte`, `RuntimeProvider.tsx`

**Strengths:**
- Sessions persist across app restarts
- Session list with timestamps
- Session switching preserved
- Model detection from session history

### 1.4 Real-Time Streaming via SSE

**Location:** `src/lib/api/tauri.ts` (OpenCodeStream class)

**Strengths:**
- Robust SSE connection with auto-reconnect
- Event buffering during connection establishment
- Clean disconnection handling

### 1.5 Cancel/Abort Capability

**Location:** `RuntimeProvider.tsx`

**Strengths:**
- `onCancel` handler exists for stopping AI execution
- Session abort API is wired up

---

## 2. Missing Critical Patterns (Must Implement)

### 2.1 Progressive Autonomy - NOT FOUND

**Problem:** Users cannot adjust how much autonomy the AI has. There's no graduated trust model.

**Current State:**
- All permission decisions are binary per-action
- No user-facing autonomy levels
- No memory of user preferences beyond "Always Allow"

**Impact:** Users must repeatedly approve similar actions, or grant blanket permissions without nuance.

**Recommended Implementation:**
```svelte
<AutonomySettings>
  <Label>Agent Autonomy Level</Label>
  <RadioGroup bind:value={autonomyLevel}>
    <RadioItem value="supervised">
      <strong>Supervised</strong>
      <span class="text-muted-foreground">Approve every action</span>
    </RadioItem>
    <RadioItem value="assisted">
      <strong>Assisted</strong>
      <span class="text-muted-foreground">Approve file changes, auto-allow reads</span>
    </RadioItem>
    <RadioItem value="autonomous">
      <strong>Autonomous</strong>
      <span class="text-muted-foreground">Auto-approve within project scope</span>
    </RadioItem>
  </RadioGroup>
</AutonomySettings>
```

### 2.2 Status Transparency - MINIMAL

**Problem:** The loading indicator is too simple ("Thinking..."). No visibility into what the AI is actually doing.

**Current State (ChatThread.tsx):**
```tsx
<span>Thinking...</span> // Too opaque!
```

**Missing:**
- Current file being read/analyzed
- Step-by-step progress (e.g., "Analyzing 23 files...")
- Reasoning visibility (why is AI taking this action?)
- Token/cost usage indicators
- Estimated time remaining

**Recommended Implementation:**
```tsx
function EnhancedLoadingIndicator({ streamStatus }) {
  return (
    <div className="rounded-lg bg-muted p-4">
      <div className="flex items-center gap-2 mb-2">
        <Spinner />
        <span className="font-medium">{streamStatus.phase || "Processing..."}</span>
      </div>
      {streamStatus.currentFile && (
        <div className="text-xs text-muted-foreground font-mono">
          Reading: {streamStatus.currentFile}
        </div>
      )}
      {streamStatus.toolsRun > 0 && (
        <div className="text-xs text-muted-foreground mt-1">
          {streamStatus.toolsRun} actions completed
        </div>
      )}
    </div>
  );
}
```

### 2.3 Graceful Pause/Resume - NOT FOUND

**Problem:** Only "cancel" exists. Users cannot pause and resume agent work.

**Current State:**
- `opencodeAbortSession` exists but is destructive
- No pause/resume workflow
- No "take over manually" handoff

**Impact:** Users lose all progress if they need to intervene mid-task.

**Recommended Implementation:**
```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  export let isRunning: boolean;
  export let isPaused = false;
  
  const dispatch = createEventDispatcher();
</script>

<div class="flex gap-2">
  {#if isRunning && !isPaused}
    <Button variant="outline" onclick={() => dispatch("pause")}>
      <PauseIcon /> Pause
    </Button>
  {:else if isPaused}
    <Button onclick={() => dispatch("resume")}>
      <PlayIcon /> Resume
    </Button>
    <Button variant="secondary" onclick={() => dispatch("takeover")}>
      Edit Plan
    </Button>
  {/if}
  <Button variant="destructive" onclick={() => dispatch("cancel")}>
    <StopIcon /> Cancel
  </Button>
</div>
```

### 2.4 Ambient Status Indicators - MINIMAL

**Problem:** No quick-glance status for projects/agents outside the active chat.

**Current State (`projects/+page.svelte`):**
- Project status badges: "running" | "stopped" | "error" | "creating"
- But no indication of *what* a running project is doing
- No notification when agent needs attention
- No activity indicator in project list

**Missing:**
- "AI working on: Add authentication" in project cards
- Push notifications when AI needs input
- Background task monitoring
- Quick status check without entering project

**Recommended Implementation:**
```svelte
<AgentStatusIndicator 
  status="thinking" 
  currentAction="Analyzing: src/api/client.ts"
  progress={65}
/>
```

### 2.5 Undo/Revert System - MINIMAL

**Problem:** Cannot easily undo AI-made changes.

**Current State:**
- `/undo` command exists in CommandPicker but behavior unclear
- No visual "Undo all changes from this session" button
- No diff preview before committing changes

**Impact:** Users lack confidence to let AI make significant changes.

**Recommended Implementation:**
```svelte
<Card>
  <CardHeader>
    <CardTitle>Session Summary</CardTitle>
  </CardHeader>
  <CardContent>
    <div class="space-y-2">
      {#each completedActions as action}
        <div class="flex items-center gap-2">
          <CheckCircleIcon class="text-green-500" />
          <span>{action.description}</span>
        </div>
      {/each}
    </div>
    <Button variant="outline" class="mt-4" onclick={undoAll}>
      Revert All Changes
    </Button>
  </CardContent>
</Card>
```

---

## 3. Recommended Enhancements (Prioritized)

### Priority 1: Critical (Implement First)

#### 3.1.1 Agent Activity Indicator

**Component:** `AgentStatusIndicator.svelte`

**Where to Add:**
- Project cards in list (`projects/+page.svelte`)
- Project header (`projects/[id]/+layout.svelte`)
- System tray (future)

#### 3.1.2 Enhanced Thinking Indicator

Update `LoadingIndicator` in `ChatThread.tsx` to show:
- Current phase/action
- Current file being processed
- Number of tools run

#### 3.1.3 Permission Context in Permission Bar

Add expandable context showing:
- What will happen if allowed
- Files that will be affected
- Command preview with syntax highlighting

### Priority 2: Important

#### 3.2.1 Pause/Resume Capability

**Implementation Notes:**
- Requires checking if OpenCode API supports pause
- Alternatively, implement client-side queue that holds pending messages

#### 3.2.2 Task Summary Panel

Show what AI has accomplished in current session:
- List of completed actions
- Files modified
- Revert all changes button

#### 3.2.3 Project Activity Feed

New tab or section showing:
- Recent AI actions
- Commands run
- Files analyzed

### Priority 3: Enhancements

#### 3.3.1 Autonomy Settings Panel

Per-project or global autonomy level settings.

#### 3.3.2 Confidence Indicators

Show AI's confidence in proposed changes.

#### 3.3.3 Mobile-First Quick Actions

Quick check-and-go workflow:
- Approve All
- Review Changes
- Commit & Push

---

## 4. Implementation Roadmap

### Phase 1: Transparency (1-2 weeks)
1. Enhanced `LoadingIndicator` with current action
2. Tool call status improvements (show file paths)
3. Project card activity indicators
4. Session summary in chat

### Phase 2: Control (2-3 weeks)
1. Pause/Resume infrastructure
2. Task control bar component
3. Undo/Revert system integration
4. Improved permission context preview

### Phase 3: Trust Building (2-3 weeks)
1. Autonomy level settings
2. Activity feed/history
3. Confidence indicators
4. Push notifications for agent attention

### Phase 4: Mobile Optimization (1-2 weeks)
1. Quick action bar
2. Notification-driven workflow
3. Pull-to-refresh patterns
4. Background status checks

---

## 5. Specific File Changes Summary

| File | Change Required | Priority |
|------|-----------------|----------|
| `ChatThread.tsx` | Enhanced LoadingIndicator with action context | P1 |
| `PermissionBar.tsx` | Add expandable context/preview | P1 |
| `RuntimeProvider.tsx` | Expose streaming state for status indicators | P1 |
| `projects/+page.svelte` | Add AgentStatusIndicator to project cards | P1 |
| `projects/[id]/+layout.svelte` | Add status to header, add activity tab | P2 |
| `stores/` | New `agent-status.svelte.ts` store | P2 |
| `settings/+page.svelte` | Add autonomy level settings | P3 |
| `lib/components/` | New TaskControl, ActivityFeed, QuickActions | P2-P3 |

---

## 6. Design System Alignment

The existing `docs/design-language.md` already defines:
- Status colors (running=green, thinking=blue, waiting=yellow, etc.)
- Animation principles (150-300ms, ease-out)
- Permission request patterns (card with border-l-4)

All new components should follow these established patterns for consistency.

---

## 7. Conclusion

AgentPod has solid foundations for an agentic UX but is currently operating more like a traditional chat interface than a true "Portable Command Center." The most critical gaps are:

1. **Lack of transparency** - Users can't see what the AI is doing in real-time
2. **No pause/resume** - Only destructive cancel available
3. **Minimal ambient awareness** - No quick-glance status indicators
4. **No autonomy controls** - Binary permissions only

Implementing the Priority 1 items would significantly improve the user experience for remote AI agent management, building the trust necessary for users to confidently delegate complex tasks to their AI agents.

---

*Report generated: December 2024*
