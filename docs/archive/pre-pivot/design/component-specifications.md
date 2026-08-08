# Component Specifications

**Application:** AgentPod  
**Date:** December 2024  
**Status:** Design Phase  
**Reference:** See `mockups/component-library.html` for visual examples

This document provides complete TypeScript specifications for all UI components, including props, variants, accessibility requirements, and platform adaptations.

---

## Table of Contents

1. [Design Tokens](#design-tokens)
2. [Primitives](#primitives)
   - [Status Indicator](#status-indicator)
   - [Badge](#badge)
   - [Button](#button)
   - [Input](#input)
   - [Card](#card)
3. [Tool Components](#tool-components)
   - [ToolCard (Base)](#toolcard-base)
   - [ReadFileTool](#readfiletool)
   - [EditFileTool](#editfiletool)
   - [BashTool](#bashtool)
   - [SearchTool (Glob/Grep)](#searchtool-globgrep)
4. [State Components](#state-components)
   - [Skeleton](#skeleton)
   - [Empty State](#empty-state)
   - [Error State](#error-state)
5. [Navigation Components](#navigation-components)
   - [Sidebar](#sidebar)
   - [BottomNav](#bottomnav)
   - [Tabs](#tabs)
6. [Intent Components](#intent-components)
   - [IntentInput](#intentinput)
   - [QuickActions](#quickactions)
   - [AttentionBanner](#attentionbanner)
7. [Accessibility Guidelines](#accessibility-guidelines)
8. [Platform Adaptations](#platform-adaptations)

---

## Design Tokens

### Colors (OKLCH)

```typescript
// Status colors
const statusColors = {
  active: "oklch(0.7 0.15 145)",      // Green - running, connected
  thinking: "oklch(0.75 0.15 85)",    // Yellow/amber - processing
  waiting: "oklch(0.7 0.15 250)",     // Blue - awaiting input
  paused: "oklch(0.6 0.1 280)",       // Purple - paused state
  error: "oklch(0.65 0.2 25)",        // Red - error, failed
  idle: "oklch(0.6 0.02 250)",        // Gray - inactive
} as const;

// Surface colors
const surfaceColors = {
  attention: "oklch(0.95 0.05 85)",   // Light amber background
  success: "oklch(0.95 0.05 145)",    // Light green background
  error: "oklch(0.95 0.05 25)",       // Light red background
} as const;

// Tailwind CSS variable mappings
const cssVariables = {
  "--status-active": statusColors.active,
  "--status-thinking": statusColors.thinking,
  "--status-waiting": statusColors.waiting,
  "--status-paused": statusColors.paused,
  "--status-error": statusColors.error,
  "--status-idle": statusColors.idle,
  "--surface-attention": surfaceColors.attention,
  "--surface-success": surfaceColors.success,
  "--surface-error": surfaceColors.error,
};
```

### Spacing Scale

```typescript
const spacing = {
  xs: "0.25rem",  // 4px
  sm: "0.5rem",   // 8px
  md: "1rem",     // 16px
  lg: "1.5rem",   // 24px
  xl: "2rem",     // 32px
  "2xl": "3rem",  // 48px
} as const;
```

### Typography Scale

```typescript
const typography = {
  xs: { size: "0.75rem", lineHeight: "1rem" },     // 12px
  sm: { size: "0.875rem", lineHeight: "1.25rem" }, // 14px
  base: { size: "1rem", lineHeight: "1.5rem" },    // 16px
  lg: { size: "1.125rem", lineHeight: "1.75rem" }, // 18px
  xl: { size: "1.25rem", lineHeight: "1.75rem" },  // 20px
  "2xl": { size: "1.5rem", lineHeight: "2rem" },   // 24px
  "3xl": { size: "1.875rem", lineHeight: "2.25rem" }, // 30px
} as const;
```

### Touch Targets

```typescript
const touchTargets = {
  minimum: "44px",    // WCAG minimum
  comfortable: "48px", // Recommended
  large: "56px",       // Large buttons
} as const;
```

---

## Primitives

### Status Indicator

Visual indicator for connection and session states.

```typescript
interface StatusIndicatorProps {
  /** Current status state */
  status: "active" | "thinking" | "waiting" | "paused" | "error" | "idle";
  
  /** Visual style variant */
  variant?: "dot" | "badge" | "icon" | "progress";
  
  /** Size of the indicator */
  size?: "sm" | "md" | "lg";
  
  /** Optional label text (for badge variant) */
  label?: string;
  
  /** Show pulsing animation for active states */
  animate?: boolean;
  
  /** Additional CSS classes */
  class?: string;
}

// Default values
const statusIndicatorDefaults = {
  variant: "dot",
  size: "md",
  animate: true,
};
```

#### Variant Specifications

| Variant | Description | Use Case |
|---------|-------------|----------|
| `dot` | Small colored circle | Inline status next to text |
| `badge` | Rounded pill with label | Status with description |
| `icon` | Status-specific icon | When meaning needs clarity |
| `progress` | Animated bar/spinner | During active processing |

#### Size Specifications

| Size | Dot Diameter | Badge Height | Icon Size |
|------|--------------|--------------|-----------|
| `sm` | 8px | 20px | 14px |
| `md` | 10px | 24px | 16px |
| `lg` | 12px | 28px | 20px |

#### Accessibility

```typescript
// ARIA attributes
const statusAriaProps = {
  role: "status",
  "aria-live": "polite",
  "aria-label": `Status: ${status}`, // Dynamic
};

// Screen reader text mapping
const statusLabels: Record<Status, string> = {
  active: "Active and running",
  thinking: "Processing",
  waiting: "Waiting for input",
  paused: "Paused",
  error: "Error occurred",
  idle: "Idle",
};
```

---

### Badge

Small label for counts, file types, and metadata.

```typescript
interface BadgeProps {
  /** Badge content (text or number) */
  children: React.ReactNode;
  
  /** Visual variant */
  variant?: "default" | "secondary" | "outline" | "destructive" | "success";
  
  /** Badge size */
  size?: "sm" | "md";
  
  /** File type icon (for file badges) */
  fileType?: "ts" | "js" | "svelte" | "css" | "json" | "md" | "rs" | "other";
  
  /** Show as modified state */
  modified?: boolean;
  
  /** Additional CSS classes */
  class?: string;
}
```

#### Variant Styles

```css
/* Tailwind classes per variant */
.badge-default { @apply bg-primary text-primary-foreground; }
.badge-secondary { @apply bg-secondary text-secondary-foreground; }
.badge-outline { @apply border border-input bg-background; }
.badge-destructive { @apply bg-destructive text-destructive-foreground; }
.badge-success { @apply bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100; }
```

---

### Button

Primary interactive element.

```typescript
interface ButtonProps {
  /** Button content */
  children: React.ReactNode;
  
  /** Visual variant */
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  
  /** Button size */
  size?: "sm" | "default" | "lg" | "icon";
  
  /** Icon to show before text */
  iconLeft?: React.ComponentType<{ className?: string }>;
  
  /** Icon to show after text */
  iconRight?: React.ComponentType<{ className?: string }>;
  
  /** Loading state */
  loading?: boolean;
  
  /** Disabled state */
  disabled?: boolean;
  
  /** Full width button */
  fullWidth?: boolean;
  
  /** Click handler */
  onClick?: (event: React.MouseEvent) => void;
  
  /** Button type */
  type?: "button" | "submit" | "reset";
  
  /** Additional CSS classes */
  class?: string;
}
```

#### Size Specifications

| Size | Height | Padding X | Font Size | Icon Size |
|------|--------|-----------|-----------|-----------|
| `sm` | 32px | 12px | 14px | 14px |
| `default` | 40px | 16px | 14px | 16px |
| `lg` | 48px | 24px | 16px | 20px |
| `icon` | 40px | 0 | - | 16px |

#### Loading State

```typescript
// When loading=true:
// - Show spinner icon
// - Disable pointer events
// - Reduce opacity slightly
// - Announce "Loading" to screen readers

const LoadingButton = ({ loading, children, ...props }) => (
  <button 
    {...props} 
    disabled={loading || props.disabled}
    aria-busy={loading}
  >
    {loading && <Spinner className="mr-2 h-4 w-4 animate-spin" />}
    {children}
  </button>
);
```

---

### Input

Text input fields including the large intent input.

```typescript
interface InputProps {
  /** Input value */
  value?: string;
  
  /** Placeholder text */
  placeholder?: string;
  
  /** Input type */
  type?: "text" | "email" | "password" | "url" | "search";
  
  /** Disabled state */
  disabled?: boolean;
  
  /** Error state */
  error?: boolean;
  
  /** Error message */
  errorMessage?: string;
  
  /** Icon to show at start */
  iconLeft?: React.ComponentType<{ className?: string }>;
  
  /** Icon to show at end */
  iconRight?: React.ComponentType<{ className?: string }>;
  
  /** Change handler */
  onChange?: (value: string) => void;
  
  /** Submit handler (for search inputs) */
  onSubmit?: (value: string) => void;
  
  /** Additional CSS classes */
  class?: string;
}

interface TextareaProps extends Omit<InputProps, "type" | "iconLeft" | "iconRight"> {
  /** Number of visible rows */
  rows?: number;
  
  /** Auto-resize based on content */
  autoResize?: boolean;
  
  /** Maximum height when auto-resizing */
  maxHeight?: number;
}
```

#### Error State

```typescript
// Error styling
const errorClasses = "border-destructive focus:ring-destructive";

// Error message display
const InputWithError = ({ error, errorMessage, ...props }) => (
  <div className="space-y-1">
    <input 
      {...props} 
      className={cn(props.className, error && errorClasses)}
      aria-invalid={error}
      aria-describedby={error ? `${props.id}-error` : undefined}
    />
    {error && errorMessage && (
      <p id={`${props.id}-error`} className="text-sm text-destructive">
        {errorMessage}
      </p>
    )}
  </div>
);
```

---

### Card

Container for grouped content.

```typescript
interface CardProps {
  /** Card content */
  children: React.ReactNode;
  
  /** Visual variant */
  variant?: "default" | "outline" | "elevated" | "attention";
  
  /** Clickable card */
  interactive?: boolean;
  
  /** Click handler */
  onClick?: () => void;
  
  /** Additional CSS classes */
  class?: string;
}

interface ProjectCardProps {
  /** Project data */
  project: {
    id: string;
    name: string;
    description?: string;
    status: "active" | "idle" | "error";
    lastActive?: Date;
    activeSessions?: number;
  };
  
  /** Click handler */
  onClick?: (projectId: string) => void;
  
  /** Show attention indicator */
  needsAttention?: boolean;
}

interface SessionCardProps {
  /** Session data */
  session: {
    id: string;
    title?: string;
    status: "active" | "thinking" | "waiting" | "paused" | "error" | "idle";
    lastMessage?: string;
    updatedAt: Date;
  };
  
  /** Click handler */
  onClick?: (sessionId: string) => void;
  
  /** Compact display mode */
  compact?: boolean;
}
```

#### Variant Styles

```css
.card-default { @apply bg-card text-card-foreground rounded-lg border; }
.card-outline { @apply bg-transparent border-2; }
.card-elevated { @apply bg-card shadow-md; }
.card-attention { @apply bg-[--surface-attention] border-[--status-waiting]; }
```

---

## Tool Components

### ToolCard (Base)

Base wrapper for all tool UI components.

```typescript
interface ToolCardProps {
  /** Tool name identifier */
  toolName: string;
  
  /** Display title (can differ from toolName) */
  title?: string;
  
  /** Tool execution status */
  status: "pending" | "running" | "completed" | "error";
  
  /** Collapsible state */
  collapsed?: boolean;
  
  /** Default collapsed state */
  defaultCollapsed?: boolean;
  
  /** Toggle collapse handler */
  onToggleCollapse?: (collapsed: boolean) => void;
  
  /** Show timestamp */
  showTimestamp?: boolean;
  
  /** Execution timestamp */
  timestamp?: Date;
  
  /** Card content */
  children: React.ReactNode;
  
  /** Header actions (buttons) */
  headerActions?: React.ReactNode;
  
  /** Footer content */
  footer?: React.ReactNode;
  
  /** Error message (when status is error) */
  errorMessage?: string;
  
  /** Additional CSS classes */
  class?: string;
}
```

#### Status Styling

```typescript
const statusStyles = {
  pending: {
    borderColor: "border-muted",
    icon: Clock,
    label: "Pending",
  },
  running: {
    borderColor: "border-[--status-thinking]",
    icon: Loader2,
    iconClass: "animate-spin",
    label: "Running",
  },
  completed: {
    borderColor: "border-[--status-active]",
    icon: Check,
    label: "Completed",
  },
  error: {
    borderColor: "border-[--status-error]",
    icon: XCircle,
    label: "Error",
  },
};
```

#### Accessibility

```typescript
const toolCardA11y = {
  role: "region",
  "aria-label": `${toolName} tool result`,
  "aria-expanded": !collapsed,
  "aria-busy": status === "running",
};

// Collapse button
const collapseButtonA11y = {
  "aria-expanded": !collapsed,
  "aria-controls": `tool-content-${toolName}`,
};
```

---

### ReadFileTool

Displays file content with syntax highlighting.

```typescript
interface ReadFileToolProps {
  /** Tool execution status */
  status: "pending" | "running" | "completed" | "error";
  
  /** Tool arguments */
  args: {
    filePath: string;
    offset?: number;
    limit?: number;
  };
  
  /** File content result */
  result?: string;
  
  /** Error message */
  error?: string;
  
  /** Whether file was truncated */
  truncated?: boolean;
  
  /** Total lines in file */
  totalLines?: number;
}
```

#### Features

| Feature | Implementation |
|---------|---------------|
| Syntax highlighting | Use `highlight.js` or `shiki` based on file extension |
| Line numbers | Show line numbers with optional range highlighting |
| Copy button | Copy content to clipboard with feedback |
| Collapse/Expand | Toggle full content vs preview (first 20 lines) |
| File icon | Icon based on file type |
| Truncation notice | Show when file was truncated |

#### Code Block Styling

```typescript
const codeBlockStyles = {
  container: "rounded-md border bg-muted/50 overflow-hidden",
  header: "flex items-center justify-between px-3 py-2 bg-muted border-b",
  content: "overflow-x-auto",
  lineNumber: "select-none text-muted-foreground text-right pr-4 w-12",
  code: "font-mono text-sm",
};
```

---

### EditFileTool

Shows diff between old and new content.

```typescript
interface EditFileToolProps {
  /** Tool execution status */
  status: "pending" | "running" | "completed" | "error";
  
  /** Tool arguments */
  args: {
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  };
  
  /** Success/error message */
  result?: string;
  
  /** Error message */
  error?: string;
  
  /** Diff view mode */
  viewMode?: "inline" | "split";
  
  /** Show surrounding context lines */
  contextLines?: number;
}
```

#### Diff Styling

```typescript
const diffStyles = {
  added: {
    bg: "bg-green-50 dark:bg-green-950",
    border: "border-l-2 border-green-500",
    text: "text-green-800 dark:text-green-200",
    prefix: "+",
  },
  removed: {
    bg: "bg-red-50 dark:bg-red-950",
    border: "border-l-2 border-red-500",
    text: "text-red-800 dark:text-red-200",
    prefix: "-",
  },
  context: {
    bg: "bg-transparent",
    border: "border-l-2 border-transparent",
    text: "text-muted-foreground",
    prefix: " ",
  },
};
```

---

### BashTool

Terminal-style command output display.

```typescript
interface BashToolProps {
  /** Tool execution status */
  status: "pending" | "running" | "completed" | "error";
  
  /** Tool arguments */
  args: {
    command: string;
    description?: string;
    timeout?: number;
  };
  
  /** Command output */
  result?: string;
  
  /** Exit code */
  exitCode?: number;
  
  /** Error message */
  error?: string;
  
  /** Enable streaming output */
  streaming?: boolean;
  
  /** Current streaming content */
  streamContent?: string;
}
```

#### Terminal Styling

```typescript
const terminalStyles = {
  container: "rounded-md bg-zinc-900 text-zinc-100 font-mono text-sm overflow-hidden",
  header: "flex items-center gap-2 px-3 py-2 bg-zinc-800 border-b border-zinc-700",
  prompt: "text-green-400",
  command: "text-zinc-100",
  output: "p-3 overflow-x-auto whitespace-pre-wrap",
  error: "text-red-400",
  success: "text-green-400",
};

// ANSI color mapping
const ansiColors = {
  "30": "text-zinc-900",
  "31": "text-red-500",
  "32": "text-green-500",
  "33": "text-yellow-500",
  "34": "text-blue-500",
  "35": "text-purple-500",
  "36": "text-cyan-500",
  "37": "text-zinc-100",
};
```

---

### SearchTool (Glob/Grep)

Search results display for file finding operations.

```typescript
interface SearchToolProps {
  /** Tool type */
  toolType: "glob" | "grep";
  
  /** Tool execution status */
  status: "pending" | "running" | "completed" | "error";
  
  /** Search arguments */
  args: {
    pattern: string;
    path?: string;
    include?: string;
  };
  
  /** Search results */
  results?: string[];
  
  /** For grep: matches with context */
  matches?: GrepMatch[];
  
  /** Error message */
  error?: string;
  
  /** File click handler */
  onFileClick?: (filePath: string) => void;
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
  matchStart: number;
  matchEnd: number;
}
```

#### File List Styling

```typescript
const fileListStyles = {
  container: "divide-y",
  item: "flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors cursor-pointer",
  icon: "w-4 h-4 text-muted-foreground",
  path: "flex-1 truncate font-mono text-sm",
  directory: "text-muted-foreground",
  filename: "text-foreground",
};

// File type icons
const fileIcons = {
  ts: TypeScriptIcon,
  tsx: ReactIcon,
  js: JavaScriptIcon,
  jsx: ReactIcon,
  svelte: SvelteIcon,
  css: CSSIcon,
  json: JSONIcon,
  md: MarkdownIcon,
  rs: RustIcon,
  default: FileIcon,
};
```

---

## State Components

### Skeleton

Loading placeholder animations.

```typescript
interface SkeletonProps {
  /** Width of skeleton */
  width?: string | number;
  
  /** Height of skeleton */
  height?: string | number;
  
  /** Rounded corners */
  rounded?: "sm" | "md" | "lg" | "full";
  
  /** Custom CSS classes */
  class?: string;
}

interface SkeletonCardProps {
  /** Show avatar placeholder */
  showAvatar?: boolean;
  
  /** Number of text lines */
  lines?: number;
  
  /** Show action buttons */
  showActions?: boolean;
}

interface SkeletonListProps {
  /** Number of items */
  count?: number;
  
  /** Item variant */
  variant?: "simple" | "detailed";
}
```

#### Animation

```css
@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.skeleton {
  @apply bg-muted animate-pulse;
  animation: skeleton-pulse 2s ease-in-out infinite;
}
```

---

### Empty State

Display when no content is available.

```typescript
interface EmptyStateProps {
  /** Icon to display */
  icon?: React.ComponentType<{ className?: string }>;
  
  /** Main heading */
  title: string;
  
  /** Description text */
  description?: string;
  
  /** Primary action button */
  action?: {
    label: string;
    onClick: () => void;
    variant?: ButtonProps["variant"];
  };
  
  /** Secondary action */
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  
  /** Custom illustration */
  illustration?: React.ReactNode;
  
  /** Size variant */
  size?: "sm" | "md" | "lg";
}
```

#### Predefined Empty States

```typescript
const emptyStates = {
  noProjects: {
    icon: FolderPlus,
    title: "No projects yet",
    description: "Create your first project to get started with OpenCode.",
    action: { label: "Create Project", onClick: () => {} },
  },
  noSessions: {
    icon: MessageSquare,
    title: "No sessions",
    description: "Start a new session to begin coding with AI assistance.",
    action: { label: "New Session", onClick: () => {} },
  },
  noSearchResults: {
    icon: SearchX,
    title: "No results found",
    description: "Try adjusting your search terms or filters.",
  },
  noActivity: {
    icon: Activity,
    title: "No recent activity",
    description: "Activity from your projects will appear here.",
  },
};
```

---

### Error State

Error display with recovery options.

```typescript
interface ErrorStateProps {
  /** Error type for styling */
  type?: "connection" | "permission" | "notFound" | "server" | "generic";
  
  /** Error title */
  title: string;
  
  /** Error description */
  description?: string;
  
  /** Technical error details (collapsible) */
  details?: string;
  
  /** Retry action */
  onRetry?: () => void;
  
  /** Retry button loading state */
  retrying?: boolean;
  
  /** Go back action */
  onBack?: () => void;
  
  /** Size variant */
  size?: "inline" | "card" | "fullPage";
}
```

#### Error Type Styling

```typescript
const errorTypeStyles = {
  connection: {
    icon: WifiOff,
    color: "text-yellow-500",
    bgColor: "bg-yellow-50 dark:bg-yellow-950",
  },
  permission: {
    icon: Lock,
    color: "text-orange-500",
    bgColor: "bg-orange-50 dark:bg-orange-950",
  },
  notFound: {
    icon: FileQuestion,
    color: "text-blue-500",
    bgColor: "bg-blue-50 dark:bg-blue-950",
  },
  server: {
    icon: ServerCrash,
    color: "text-red-500",
    bgColor: "bg-red-50 dark:bg-red-950",
  },
  generic: {
    icon: AlertCircle,
    color: "text-red-500",
    bgColor: "bg-red-50 dark:bg-red-950",
  },
};
```

---

## Navigation Components

### Sidebar

Desktop navigation sidebar.

```typescript
interface SidebarProps {
  /** Current active route */
  activeRoute: string;
  
  /** Navigation items */
  items: SidebarItem[];
  
  /** Collapsed state */
  collapsed?: boolean;
  
  /** Toggle collapse handler */
  onToggleCollapse?: () => void;
  
  /** User info for bottom section */
  user?: {
    name: string;
    email?: string;
    avatar?: string;
  };
  
  /** Footer content */
  footer?: React.ReactNode;
}

interface SidebarItem {
  /** Unique identifier */
  id: string;
  
  /** Display label */
  label: string;
  
  /** Icon component */
  icon: React.ComponentType<{ className?: string }>;
  
  /** Route path */
  href: string;
  
  /** Badge count */
  badge?: number;
  
  /** Badge variant */
  badgeVariant?: "default" | "destructive";
  
  /** Nested items */
  children?: SidebarItem[];
}
```

#### Collapsed State

```typescript
// When collapsed:
// - Show only icons (no labels)
// - Width: 64px
// - Tooltips on hover
// - Expand on hover (optional)

const collapsedStyles = {
  width: "w-16",
  padding: "px-2",
  itemPadding: "p-3",
  justifyContent: "justify-center",
};

const expandedStyles = {
  width: "w-64",
  padding: "px-3",
  itemPadding: "px-3 py-2",
  justifyContent: "justify-start",
};
```

---

### BottomNav

Mobile bottom navigation bar.

```typescript
interface BottomNavProps {
  /** Navigation items (max 5) */
  items: BottomNavItem[];
  
  /** Current active item */
  activeId: string;
  
  /** Item click handler */
  onItemClick: (id: string) => void;
}

interface BottomNavItem {
  /** Unique identifier */
  id: string;
  
  /** Display label */
  label: string;
  
  /** Icon component */
  icon: React.ComponentType<{ className?: string }>;
  
  /** Active icon (optional) */
  activeIcon?: React.ComponentType<{ className?: string }>;
  
  /** Badge count */
  badge?: number;
  
  /** Show attention dot */
  attention?: boolean;
}
```

#### Mobile Sizing

```typescript
const bottomNavStyles = {
  height: "h-16", // 64px - accounts for safe area
  itemWidth: "flex-1",
  iconSize: "w-6 h-6",
  labelSize: "text-xs",
  touchTarget: "min-h-[48px]",
  safeArea: "pb-safe", // iOS safe area
};
```

---

### Tabs

Horizontal tab navigation.

```typescript
interface TabsProps {
  /** Tab items */
  items: TabItem[];
  
  /** Currently active tab */
  activeId: string;
  
  /** Tab change handler */
  onChange: (id: string) => void;
  
  /** Visual variant */
  variant?: "default" | "pills" | "underline";
  
  /** Full width tabs */
  fullWidth?: boolean;
  
  /** Size */
  size?: "sm" | "md" | "lg";
}

interface TabItem {
  /** Unique identifier */
  id: string;
  
  /** Display label */
  label: string;
  
  /** Icon component */
  icon?: React.ComponentType<{ className?: string }>;
  
  /** Badge count */
  badge?: number;
  
  /** Disabled state */
  disabled?: boolean;
}
```

---

## Intent Components

### IntentInput

Large input for natural language commands.

```typescript
interface IntentInputProps {
  /** Current value */
  value?: string;
  
  /** Placeholder text */
  placeholder?: string;
  
  /** Submit handler */
  onSubmit: (value: string) => void;
  
  /** Processing state */
  processing?: boolean;
  
  /** Recent intents for autocomplete */
  recentIntents?: string[];
  
  /** Suggested intents */
  suggestions?: string[];
  
  /** Voice input enabled */
  voiceEnabled?: boolean;
  
  /** Size variant */
  size?: "default" | "large";
  
  /** Error state */
  error?: string;
  
  /** Disabled state */
  disabled?: boolean;
}
```

#### Visual Specifications

```typescript
const intentInputStyles = {
  default: {
    height: "h-14",
    fontSize: "text-lg",
    padding: "px-4",
    iconSize: "w-5 h-5",
  },
  large: {
    height: "h-16",
    fontSize: "text-xl",
    padding: "px-6",
    iconSize: "w-6 h-6",
  },
};

// Processing animation
const processingStyles = {
  border: "border-[--status-thinking]",
  animation: "animate-pulse",
  icon: Loader2,
  iconAnimation: "animate-spin",
};
```

---

### QuickActions

Pill buttons for common actions.

```typescript
interface QuickActionsProps {
  /** Action items */
  actions: QuickAction[];
  
  /** Orientation */
  orientation?: "horizontal" | "vertical";
  
  /** Wrap items */
  wrap?: boolean;
  
  /** Size */
  size?: "sm" | "md";
  
  /** Loading states by action id */
  loadingIds?: string[];
}

interface QuickAction {
  /** Unique identifier */
  id: string;
  
  /** Display label */
  label: string;
  
  /** Icon component */
  icon?: React.ComponentType<{ className?: string }>;
  
  /** Intent to trigger */
  intent: string;
  
  /** Keyboard shortcut */
  shortcut?: string;
}
```

#### Default Actions

```typescript
const defaultQuickActions: QuickAction[] = [
  { id: "projects", label: "Projects", icon: Folder, intent: "Show my projects" },
  { id: "new-session", label: "New Session", icon: Plus, intent: "Start a new session" },
  { id: "attention", label: "Attention", icon: AlertCircle, intent: "What needs my attention?" },
  { id: "activity", label: "Activity", icon: Activity, intent: "Show recent activity" },
  { id: "settings", label: "Settings", icon: Settings, intent: "Open settings" },
];
```

---

### AttentionBanner

Alert banner for items requiring user attention.

```typescript
interface AttentionBannerProps {
  /** Attention items */
  items: AttentionItem[];
  
  /** Dismiss handler */
  onDismiss?: (itemId: string) => void;
  
  /** Action click handler */
  onAction?: (item: AttentionItem) => void;
  
  /** Collapse to single line */
  collapsed?: boolean;
  
  /** Toggle collapse handler */
  onToggleCollapse?: () => void;
}

interface AttentionItem {
  /** Unique identifier */
  id: string;
  
  /** Item type */
  type: "permission" | "error" | "waiting" | "info";
  
  /** Priority level */
  priority: "high" | "medium" | "low";
  
  /** Title text */
  title: string;
  
  /** Description */
  description?: string;
  
  /** Related project */
  projectId?: string;
  projectName?: string;
  
  /** Related session */
  sessionId?: string;
  
  /** Timestamp */
  timestamp: Date;
  
  /** Action button */
  action?: {
    label: string;
    href?: string;
  };
  
  /** Dismissible */
  dismissible?: boolean;
}
```

#### Type Styling

```typescript
const attentionTypeStyles = {
  permission: {
    icon: Hand,
    color: "text-blue-600",
    bgColor: "bg-blue-50 dark:bg-blue-950",
    borderColor: "border-blue-200 dark:border-blue-800",
  },
  error: {
    icon: XCircle,
    color: "text-red-600",
    bgColor: "bg-red-50 dark:bg-red-950",
    borderColor: "border-red-200 dark:border-red-800",
  },
  waiting: {
    icon: Clock,
    color: "text-amber-600",
    bgColor: "bg-amber-50 dark:bg-amber-950",
    borderColor: "border-amber-200 dark:border-amber-800",
  },
  info: {
    icon: Info,
    color: "text-zinc-600",
    bgColor: "bg-zinc-50 dark:bg-zinc-900",
    borderColor: "border-zinc-200 dark:border-zinc-800",
  },
};
```

---

## Accessibility Guidelines

### Keyboard Navigation

```typescript
// All interactive elements must be keyboard accessible
const keyboardRequirements = {
  focusVisible: "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  tabIndex: 0, // For custom interactive elements
  escapeKey: "Close modals, menus, clear selections",
  enterKey: "Activate buttons, submit forms",
  arrowKeys: "Navigate lists, tabs, menus",
  spaceKey: "Toggle checkboxes, buttons",
};

// Focus trap for modals
const focusTrapConfig = {
  initialFocus: "first focusable element",
  returnFocus: "element that opened modal",
  escapeDeactivates: true,
};
```

### ARIA Labels

```typescript
// Required ARIA attributes by component
const ariaRequirements = {
  StatusIndicator: {
    role: "status",
    "aria-live": "polite",
    "aria-label": "required",
  },
  ToolCard: {
    role: "region",
    "aria-label": "required",
    "aria-expanded": "for collapsible",
    "aria-busy": "when running",
  },
  Button: {
    "aria-disabled": "when disabled",
    "aria-busy": "when loading",
    "aria-pressed": "for toggle buttons",
  },
  Tab: {
    role: "tablist",
    "aria-selected": "for active tab",
    "aria-controls": "panel id",
  },
  ErrorState: {
    role: "alert",
    "aria-live": "assertive",
  },
};
```

### Color Contrast

```typescript
// Minimum contrast ratios (WCAG 2.1 AA)
const contrastRequirements = {
  normalText: 4.5,      // Text < 18pt
  largeText: 3,         // Text >= 18pt or 14pt bold
  uiComponents: 3,      // Interactive elements, icons
  focusIndicator: 3,    // Focus rings
};

// All status colors must meet contrast requirements
// Test with: https://webaim.org/resources/contrastchecker/
```

### Motion Preferences

```typescript
// Respect reduced motion preferences
const motionConfig = {
  reduceMotion: "@media (prefers-reduced-motion: reduce)",
  query: "window.matchMedia('(prefers-reduced-motion: reduce)')",
};

// CSS example
const motionStyles = `
  @media (prefers-reduced-motion: reduce) {
    .animate-spin { animation: none; }
    .animate-pulse { animation: none; }
    .transition-all { transition: none; }
  }
`;
```

---

## Platform Adaptations

### Responsive Breakpoints

```typescript
const breakpoints = {
  sm: "640px",   // Mobile landscape
  md: "768px",   // Tablet portrait
  lg: "1024px",  // Tablet landscape / Small desktop
  xl: "1280px",  // Desktop
  "2xl": "1536px", // Large desktop
};

// Tailwind usage
const responsiveClasses = {
  mobile: "default classes",
  tablet: "md:classes",
  desktop: "lg:classes",
};
```

### Component Adaptations

| Component | Mobile | Tablet | Desktop |
|-----------|--------|--------|---------|
| Navigation | Bottom nav | Sidebar (collapsible) | Sidebar (expanded) |
| Cards | Full width, stacked | 2-column grid | 3-4 column grid |
| Tool cards | Collapsed by default | Expanded | Expanded with more context |
| Intent input | Fixed at bottom | Centered, large | Centered, large |
| Quick actions | Horizontal scroll | Wrap | Inline row |
| Modals | Full screen (bottom sheet) | Centered dialog | Centered dialog |
| Tabs | Scrollable | Scrollable or full | Full width |

### Touch vs Mouse

```typescript
const interactionStyles = {
  touch: {
    hoverStyles: "none", // Disable hover on touch
    pressStyles: "active:scale-95", // Press feedback
    tapHighlight: "tap-highlight-transparent",
  },
  mouse: {
    hoverStyles: "hover:bg-muted",
    pressStyles: "active:bg-muted/80",
    cursorPointer: "cursor-pointer",
  },
};

// Detect touch device
const isTouchDevice = "('ontouchstart' in window) || (navigator.maxTouchPoints > 0)";
```

### Safe Areas

```typescript
// iOS safe area insets
const safeAreaStyles = {
  paddingTop: "pt-safe",
  paddingBottom: "pb-safe",
  paddingLeft: "pl-safe",
  paddingRight: "pr-safe",
};

// Tailwind config addition
const tailwindSafeArea = {
  extend: {
    padding: {
      safe: "env(safe-area-inset-bottom)",
    },
  },
};
```

---

## Implementation Notes

### File Organization

```
src/lib/components/
├── ui/                    # shadcn/ui primitives
│   ├── button.svelte
│   ├── card.svelte
│   ├── badge.svelte
│   └── ...
├── status/                # Status components
│   ├── StatusIndicator.svelte
│   ├── AttentionBanner.svelte
│   └── ...
├── navigation/            # Nav components
│   ├── Sidebar.svelte
│   ├── BottomNav.svelte
│   └── Tabs.svelte
├── intent/                # Intent system
│   ├── IntentInput.svelte
│   ├── QuickActions.svelte
│   └── ...
├── state/                 # State display
│   ├── Skeleton.svelte
│   ├── EmptyState.svelte
│   └── ErrorState.svelte
└── index.ts               # Exports

src/lib/chat/tools/        # React tool components
├── base/
│   └── ToolCard.tsx
├── file/
│   ├── ReadFileTool.tsx
│   └── EditFileTool.tsx
├── command/
│   └── BashTool.tsx
├── search/
│   ├── GlobTool.tsx
│   └── GrepTool.tsx
└── index.ts
```

### Testing Strategy

```typescript
// Unit tests for each component
describe("StatusIndicator", () => {
  it("renders correct status color");
  it("shows animation when animate=true");
  it("has correct ARIA attributes");
  it("renders label for badge variant");
});

// Visual regression tests
describe("Visual", () => {
  it("matches snapshot for each status");
  it("matches snapshot in dark mode");
  it("matches snapshot at mobile breakpoint");
});

// Accessibility tests
describe("Accessibility", () => {
  it("has no a11y violations");
  it("is keyboard navigable");
  it("has sufficient color contrast");
});
```

---

*Document created: December 2024*
*Last updated: December 2024*
