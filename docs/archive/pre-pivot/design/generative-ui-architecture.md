# Generative UI Architecture

**Application:** AgentPod  
**Date:** December 2024  
**Status:** Design Phase

A complete architecture for intent-based generative UI where the interface dynamically adapts based on user intent and AI responses.

---

## Vision

Transform AgentPod from a traditional "pages with navigation" app into a **fluid, intent-driven interface** where:

1. **User opens app** → Sees "What's on your mind?" (not a dashboard)
2. **User states intent** → AI determines what to show
3. **Interface generates** → Relevant UI materializes based on context
4. **AI responses include UI** → Tool calls render as rich, interactive components

### Core Principle

> The UI is not designed, it's generated. The user doesn't navigate to features, they request outcomes.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GENERATIVE UI SYSTEM                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐   │
│  │   Intent    │────▶│    Route    │────▶│   Layout Generator  │   │
│  │  Detector   │     │   Resolver  │     │                     │   │
│  └─────────────┘     └─────────────┘     └─────────────────────┘   │
│         │                   │                       │               │
│         │                   │                       │               │
│         ▼                   ▼                       ▼               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐   │
│  │   Intent    │     │   Route     │     │   Component         │   │
│  │   Types     │     │   Registry  │     │   Registry          │   │
│  └─────────────┘     └─────────────┘     └─────────────────────┘   │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                        TOOL UI SYSTEM                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Tool Component Registry                   │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │  Read     │  Edit    │  Write   │  Bash    │  Glob/Grep    │   │
│  │  ────     │  ────    │  ────    │  ────    │  ────────     │   │
│  │  File     │  Diff    │  Create  │  Terminal│  Search       │   │
│  │  Viewer   │  Viewer  │  Preview │  Output  │  Results      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Generative Components                     │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │  DataTable │ FileTree │ Timeline │ MetricsCard │ ActionCard │   │
│  │  CodeBlock │ Terminal │ DiffView │ SearchPanel │ StatusGrid │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Intent Detection System

### Intent Categories

| Category | Example Phrases | Generated View |
|----------|-----------------|----------------|
| **Navigation** | "Show projects", "Go to settings" | Route to page |
| **Creation** | "Start a new project", "Begin session" | Creation wizard |
| **Status** | "What's happening?", "Any issues?" | Dashboard/Attention view |
| **Action** | "Deploy frontend", "Run tests" | Action confirmation + progress |
| **Query** | "Show logs for X", "Find files with Y" | Results view |
| **Chat** | "Help me fix this bug", "Explain this code" | Chat interface |

### Intent Detection Flow

```typescript
interface Intent {
  type: IntentType;
  confidence: number;
  entities: IntentEntity[];
  context: IntentContext;
  suggestedView: ViewType;
}

type IntentType = 
  | "navigate"      // Go somewhere
  | "create"        // Make something new
  | "status"        // Check on things
  | "action"        // Do something
  | "query"         // Find/search
  | "chat"          // Converse
  | "hybrid";       // Multiple intents

interface IntentEntity {
  type: "project" | "file" | "session" | "time" | "action";
  value: string;
  resolved?: unknown; // Resolved entity (actual project, file path, etc.)
}
```

### Detection Implementation

**Option A: Client-side heuristics (fast, offline)**
```typescript
function detectIntent(input: string): Intent {
  const patterns = {
    navigate: /^(show|go to|open|view)\s/i,
    create: /^(create|start|new|begin)\s/i,
    status: /^(what|any|how|status|check)\s/i,
    action: /^(deploy|run|stop|restart|delete)\s/i,
    query: /^(find|search|list|show me|where)\s/i,
  };
  
  // Score each pattern, return highest confidence
}
```

**Option B: AI-assisted detection (accurate, requires API)**
```typescript
// First message analyzed by AI to determine intent
// AI responds with structured intent + suggested view
```

**Recommended: Hybrid approach**
- Client-side for common patterns (instant)
- AI fallback for ambiguous intents
- User can always override: "Actually, show me as a list"

---

## Layer 2: Route Resolution

### Dynamic Route Registry

```typescript
interface RouteDefinition {
  pattern: RegExp;
  component: ComponentType;
  layout: LayoutType;
  requiredEntities: EntityType[];
  fallback?: RouteDefinition;
}

const routeRegistry: RouteDefinition[] = [
  {
    pattern: /^projects?$/i,
    component: ProjectsGrid,
    layout: "full",
    requiredEntities: [],
  },
  {
    pattern: /^project:\s*(.+)$/i,
    component: ProjectDetail,
    layout: "split",
    requiredEntities: ["project"],
  },
  {
    pattern: /^chat|help|ask$/i,
    component: ChatInterface,
    layout: "focused",
    requiredEntities: [],
  },
  // ... more routes
];
```

### View Types & Layouts

| Layout | Description | Use Case |
|--------|-------------|----------|
| `focused` | Single column, full attention | Chat, creation wizards |
| `split` | Two columns (list + detail) | Project + sessions |
| `grid` | Card grid with optional filters | Projects list, search results |
| `canvas` | Full bleed, no chrome | File viewer, diff viewer |
| `dashboard` | Multiple widgets | Status overview |

---

## Layer 3: Tool-Specific UI Components

### Tool Component Architecture

```
src/lib/chat/tools/
├── index.ts                 # Registry and exports
├── types.ts                 # Shared types
├── base/
│   ├── ToolCard.tsx         # Base wrapper component
│   └── ToolStatus.tsx       # Status indicators
├── file/
│   ├── ReadFileTool.tsx     # File viewer with syntax highlighting
│   ├── EditFileTool.tsx     # Diff viewer
│   └── WriteFileTool.tsx    # New file preview
├── command/
│   ├── BashTool.tsx         # Terminal output
│   └── CommandStatus.tsx    # Running/complete states
├── search/
│   ├── GlobTool.tsx         # File list results
│   ├── GrepTool.tsx         # Search results with context
│   └── SearchResults.tsx    # Shared search UI
└── web/
    └── WebFetchTool.tsx     # URL preview card
```

### Tool Component Specifications

#### Read File Tool
```tsx
interface ReadFileToolProps {
  toolName: "read";
  args: {
    filePath: string;
    offset?: number;
    limit?: number;
  };
  result?: string;  // File contents
  status: "pending" | "running" | "completed" | "error";
}

// Features:
// - Syntax highlighting based on file extension
// - Line numbers with optional highlighting
// - Collapsible for long files
// - Copy button
// - "Open in editor" action
// - Shows file path as header
// - Truncation indicator if file was truncated
```

#### Edit File Tool
```tsx
interface EditFileToolProps {
  toolName: "edit";
  args: {
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  };
  result?: string;  // Success/error message
  status: "pending" | "running" | "completed" | "error";
}

// Features:
// - Split diff view (old | new)
// - Inline diff view option
// - Syntax highlighting
// - Line context around changes
// - Expand to see more context
// - "View full file" action
```

#### Bash Tool
```tsx
interface BashToolProps {
  toolName: "bash";
  args: {
    command: string;
    description?: string;
    timeout?: number;
  };
  result?: string;  // Command output
  status: "pending" | "running" | "completed" | "error";
}

// Features:
// - Terminal-style output (dark bg, monospace)
// - Streaming output support
// - Command shown at top
// - Exit code indicator
// - Copy output button
// - Expandable for long output
// - ANSI color support
```

#### Glob/Grep Tool
```tsx
interface SearchToolProps {
  toolName: "glob" | "grep";
  args: {
    pattern: string;
    path?: string;
    include?: string;
  };
  result?: string[];  // Matched files
  status: "pending" | "running" | "completed" | "error";
}

// Features:
// - File list with icons by type
// - Click to read file
// - Match count badge
// - Pattern shown as header
// - Grouping by directory (optional)
// - "Search again" action
```

### Registration with assistant-ui

```tsx
// In ChatThread.tsx
import { ReadFileTool, EditFileTool, BashTool, GlobTool, GrepTool } from "./tools";

// Register tools by name
const toolComponents = {
  read: ReadFileTool,
  Read: ReadFileTool,  // Handle case variations
  edit: EditFileTool,
  Edit: EditFileTool,
  write: WriteFileTool,
  Write: WriteFileTool,
  bash: BashTool,
  Bash: BashTool,
  glob: GlobTool,
  Glob: GlobTool,
  grep: GrepTool,
  Grep: GrepTool,
  webfetch: WebFetchTool,
  WebFetch: WebFetchTool,
  Fallback: GenericToolPart,  // Catch-all
};

// In MessagePrimitive.Content
<MessagePrimitive.Content
  components={{
    Text: TextPart,
    tools: toolComponents,
    ToolGroup: ToolGroup,
  }}
/>
```

---

## Layer 4: Generative Layout System

### Dynamic Canvas

The main content area becomes a "canvas" that can render different layouts:

```svelte
<!-- GenerativeCanvas.svelte -->
<script lang="ts">
  import type { GeneratedView } from "$lib/generative/types";
  
  let { view }: { view: GeneratedView } = $props();
</script>

{#if view.layout === "focused"}
  <FocusedLayout>
    <svelte:component this={view.component} {...view.props} />
  </FocusedLayout>
{:else if view.layout === "split"}
  <SplitLayout>
    <svelte:fragment slot="sidebar">
      <svelte:component this={view.sidebar} {...view.sidebarProps} />
    </svelte:fragment>
    <svelte:fragment slot="main">
      <svelte:component this={view.component} {...view.props} />
    </svelte:fragment>
  </SplitLayout>
{:else if view.layout === "grid"}
  <GridLayout columns={view.columns}>
    {#each view.items as item}
      <svelte:component this={item.component} {...item.props} />
    {/each}
  </GridLayout>
{:else if view.layout === "dashboard"}
  <DashboardLayout>
    {#each view.widgets as widget}
      <DashboardWidget area={widget.area}>
        <svelte:component this={widget.component} {...widget.props} />
      </DashboardWidget>
    {/each}
  </DashboardLayout>
{/if}
```

### View Generator

```typescript
interface ViewGenerator {
  // Generate view from intent
  fromIntent(intent: Intent): GeneratedView;
  
  // Generate view from tool results
  fromToolResult(tool: string, result: unknown): GeneratedView;
  
  // Generate view from AI response
  fromAIResponse(response: AIResponse): GeneratedView;
}

// Example: Generate a view from search results
function generateSearchResultsView(
  results: string[],
  query: string
): GeneratedView {
  return {
    layout: "split",
    sidebar: FileTree,
    sidebarProps: { files: results, selected: null },
    component: SearchResultsPanel,
    props: {
      results,
      query,
      onFileSelect: (file: string) => {
        // Update view to show file
      },
    },
  };
}
```

---

## Layer 5: Home Experience

### Intent-First Home Page

Replace the current redirect with an intent-first interface:

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { IntentInput } from "$lib/components/intent-input.svelte";
  import { QuickActions } from "$lib/components/quick-actions.svelte";
  import { RecentContext } from "$lib/components/recent-context.svelte";
  import { AttentionBanner } from "$lib/components/attention-banner.svelte";
  import { GenerativeCanvas } from "$lib/components/generative-canvas.svelte";
  
  let view = $state<GeneratedView | null>(null);
  let attentionItems = $state<AttentionItem[]>([]);
  
  async function handleIntent(input: string) {
    const intent = await detectIntent(input);
    view = await generateView(intent);
  }
</script>

{#if view}
  <!-- Show generated view -->
  <GenerativeCanvas {view} />
{:else}
  <!-- Show intent-first home -->
  <main class="min-h-screen flex flex-col">
    <!-- Attention items if any -->
    {#if attentionItems.length > 0}
      <AttentionBanner items={attentionItems} />
    {/if}
    
    <!-- Main intent input -->
    <div class="flex-1 flex flex-col items-center justify-center p-8">
      <h1 class="text-3xl font-light text-muted-foreground mb-8">
        What's on your mind?
      </h1>
      
      <IntentInput 
        onSubmit={handleIntent}
        placeholder="Show my projects, start a session, check status..."
        class="w-full max-w-2xl"
      />
      
      <!-- Quick action suggestions -->
      <QuickActions class="mt-8" />
    </div>
    
    <!-- Recent context -->
    <RecentContext class="border-t" />
  </main>
{/if}
```

### Quick Actions Component

```svelte
<!-- QuickActions.svelte -->
<script lang="ts">
  const quickActions = [
    { icon: Folder, label: "Projects", intent: "Show my projects" },
    { icon: Plus, label: "New Session", intent: "Start a new session" },
    { icon: AlertCircle, label: "Attention", intent: "What needs my attention?" },
    { icon: Activity, label: "Activity", intent: "Show recent activity" },
    { icon: Settings, label: "Settings", intent: "Open settings" },
  ];
</script>

<div class="flex flex-wrap gap-3 justify-center">
  {#each quickActions as action}
    <button
      onclick={() => handleIntent(action.intent)}
      class="flex items-center gap-2 px-4 py-2 rounded-full 
             bg-muted hover:bg-muted/80 transition-colors"
    >
      <svelte:component this={action.icon} class="w-4 h-4" />
      <span>{action.label}</span>
    </button>
  {/each}
</div>
```

---

## Implementation Phases

### Phase 1: Tool-Specific UIs (Week 1-2)
**Priority: High | Impact: High | Effort: Medium**

1. Create tool component directory structure
2. Implement base `ToolCard` wrapper
3. Build `ReadFileTool` with syntax highlighting
4. Build `EditFileTool` with diff view
5. Build `BashTool` with terminal output
6. Build `GlobTool` and `GrepTool` with search results
7. Register components in `ChatThread.tsx`
8. Add unit tests for each tool component

**Deliverables:**
- Rich tool UIs in chat
- Better visibility into AI actions
- Copy/expand/action buttons on tool results

### Phase 2: Intent Detection (Week 2-3)
**Priority: High | Impact: High | Effort: Medium**

1. Define intent types and schemas
2. Implement client-side pattern matching
3. Create route registry
4. Build intent input component
5. Implement view generator (basic)
6. Replace home page with intent-first UI
7. Add intent confidence indicators

**Deliverables:**
- "What's on your mind?" home page
- Quick actions for common intents
- Basic navigation via intent

### Phase 3: Generative Layouts (Week 3-4)
**Priority: Medium | Impact: High | Effort: High**

1. Create layout components (Focused, Split, Grid, Dashboard)
2. Implement `GenerativeCanvas`
3. Build view composition system
4. Add layout transitions/animations
5. Implement responsive adaptations
6. Create widget components for dashboard
7. Add persistence for generated views

**Deliverables:**
- Dynamic layouts based on content
- Smooth transitions between views
- Mobile-optimized layouts

### Phase 4: Advanced Generation (Week 4-5)
**Priority: Medium | Impact: Medium | Effort: High**

1. AI-assisted intent detection
2. Contextual suggestions
3. View memory/history
4. Multi-intent handling
5. View editing/customization
6. Export/share generated views
7. Ambient awareness integration

**Deliverables:**
- Smarter intent understanding
- "Remember this view" capability
- Share views with others

### Phase 5: Polish & Performance (Week 5-6)
**Priority: Medium | Impact: Medium | Effort: Medium**

1. Loading skeletons for generated views
2. Error boundaries and fallbacks
3. Performance optimization
4. Accessibility audit
5. Mobile testing and refinement
6. Documentation

---

## Component Specifications

### Intent Input Component

```typescript
interface IntentInputProps {
  onSubmit: (intent: string) => void;
  placeholder?: string;
  suggestions?: string[];
  recentIntents?: string[];
  disabled?: boolean;
}
```

**Features:**
- Large, prominent text input
- Voice input option (stretch goal)
- Autocomplete from recent intents
- Suggestion chips below
- Loading state during processing
- Error state with retry

### Generated View Types

```typescript
interface GeneratedView {
  id: string;
  layout: LayoutType;
  component: ComponentType;
  props: Record<string, unknown>;
  
  // For split layouts
  sidebar?: ComponentType;
  sidebarProps?: Record<string, unknown>;
  
  // For grid/dashboard layouts
  items?: GeneratedViewItem[];
  widgets?: DashboardWidget[];
  columns?: number;
  
  // Metadata
  title?: string;
  description?: string;
  actions?: ViewAction[];
  breadcrumbs?: Breadcrumb[];
}

interface ViewAction {
  label: string;
  icon?: ComponentType;
  onClick: () => void;
  variant?: "default" | "destructive" | "outline";
}
```

### Attention System

```typescript
interface AttentionItem {
  id: string;
  type: "permission" | "error" | "waiting" | "complete";
  priority: "high" | "medium" | "low";
  title: string;
  description?: string;
  projectId?: string;
  sessionId?: string;
  timestamp: Date;
  action?: {
    label: string;
    onClick: () => void;
  };
}
```

---

## File Structure (Final)

```
src/
├── lib/
│   ├── generative/
│   │   ├── intent/
│   │   │   ├── detector.ts         # Intent detection logic
│   │   │   ├── types.ts            # Intent types
│   │   │   ├── patterns.ts         # Pattern matching
│   │   │   └── resolver.ts         # Entity resolution
│   │   ├── layout/
│   │   │   ├── Focused.svelte      # Single column layout
│   │   │   ├── Split.svelte        # Two column layout
│   │   │   ├── Grid.svelte         # Card grid layout
│   │   │   ├── Dashboard.svelte    # Widget dashboard
│   │   │   └── Canvas.svelte       # Dynamic canvas
│   │   ├── views/
│   │   │   ├── generator.ts        # View generation logic
│   │   │   ├── registry.ts         # Component registry
│   │   │   └── types.ts            # View types
│   │   └── index.ts
│   ├── chat/
│   │   ├── tools/
│   │   │   ├── base/
│   │   │   │   ├── ToolCard.tsx
│   │   │   │   └── ToolStatus.tsx
│   │   │   ├── file/
│   │   │   │   ├── ReadFileTool.tsx
│   │   │   │   ├── EditFileTool.tsx
│   │   │   │   └── WriteFileTool.tsx
│   │   │   ├── command/
│   │   │   │   └── BashTool.tsx
│   │   │   ├── search/
│   │   │   │   ├── GlobTool.tsx
│   │   │   │   └── GrepTool.tsx
│   │   │   ├── web/
│   │   │   │   └── WebFetchTool.tsx
│   │   │   └── index.ts
│   │   └── ... (existing files)
│   └── components/
│       ├── intent-input.svelte
│       ├── quick-actions.svelte
│       ├── recent-context.svelte
│       ├── attention-banner.svelte
│       └── generative-canvas.svelte
└── routes/
    └── +page.svelte                # Intent-first home
```

---

## Technical Considerations

### Performance

1. **Lazy loading**: Tool components loaded on demand
2. **View caching**: Generated views cached for instant back navigation
3. **Streaming**: Tool results stream as they arrive
4. **Code splitting**: Each tool UI is a separate chunk

### Accessibility

1. **Focus management**: Focus moves to generated content
2. **ARIA live regions**: Announce view changes
3. **Keyboard navigation**: Full keyboard support
4. **Screen reader**: Describe generated layouts

### Mobile Adaptations

1. **Touch-first**: Large touch targets on generated components
2. **Responsive layouts**: Grid → Stack on mobile
3. **Gesture support**: Swipe to dismiss, pull to refresh
4. **Bottom sheet**: Modal content uses bottom sheet on mobile

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Intent recognition accuracy | > 85% | Track corrections/retries |
| Time to first interaction | < 500ms | Lighthouse |
| View generation time | < 200ms | Performance monitoring |
| User satisfaction | > 4/5 | In-app feedback |
| Navigation reduction | > 50% | Analytics: clicks to complete task |

---

## Open Questions

1. **Persistence**: Should generated views be saved? How long?
2. **Customization**: Can users modify generated layouts?
3. **Fallback**: What happens when intent is unclear?
4. **Learning**: Should the system learn user preferences?
5. **Offline**: How do generated views work offline?

---

## Next Steps

1. **Review and approve** this architecture document
2. **Create component stubs** for tool UIs
3. **Implement ReadFileTool** as the first tool component
4. **Build intent input** component
5. **Replace home page** with intent-first UI

---

*Document created: December 2024*
*Last updated: December 2024*
