# Design Language Foundation

**Project**: AgentPod - Portable Command Center
**Version**: 1.0.0
**Last Updated**: December 2024

---

## Philosophy

### Vision Statement

Create an interface that feels like a **trusted companion** for developers managing AI coding agents. The experience should be:
- **Calm, not chaotic** - Despite complex AI operations happening in the background
- **Informative, not overwhelming** - Show progress without noise
- **Confident, not cautious** - Empower users while maintaining safety
- **Native, not web-y** - Feel like a proper desktop/mobile app, not a website

### Design Pillars

#### 1. Purposeful Minimalism
Every element earns its place on screen. We remove visual noise ruthlessly, embracing whitespace as a design element. When in doubt, leave it out.

#### 2. Ambient Awareness
Users should always know what's happening without actively looking. Status information lives in the periphery, demanding attention only when necessary. Think: dashboard gauges, not alert sirens.

#### 3. Progressive Disclosure
Complexity exists but reveals itself only when needed. Primary actions are immediate; secondary actions are accessible. Power users discover depth; new users aren't overwhelmed.

#### 4. Trustworthy Automation
AI actions are visible, reversible, and controllable. We never surprise users with unexpected changes. Permission patterns build trust through transparency.

#### 5. Adaptive Experience
The interface transforms thoughtfully across devices. Mobile isn't a compressed desktop; it's purpose-built for quick checks and approvals. Desktop isn't bloated mobile; it leverages screen real estate for power users.

---

## Color System

### Semantic Colors

| Token | Purpose | Light Mode | Dark Mode |
|-------|---------|------------|-----------|
| `--background` | Page background | `hsl(0 0% 100%)` | `hsl(224 71% 4%)` |
| `--foreground` | Primary text | `hsl(224 71% 4%)` | `hsl(213 31% 91%)` |
| `--muted` | Subtle backgrounds | `hsl(220 14% 96%)` | `hsl(223 47% 11%)` |
| `--muted-foreground` | Secondary text | `hsl(220 9% 46%)` | `hsl(215 20% 65%)` |
| `--primary` | Primary actions | `hsl(220 90% 56%)` | `hsl(213 94% 68%)` |
| `--primary-foreground` | Text on primary | `hsl(0 0% 100%)` | `hsl(224 71% 4%)` |
| `--destructive` | Danger/errors | `hsl(0 84% 60%)` | `hsl(0 62% 30%)` |
| `--border` | Borders | `hsl(220 13% 91%)` | `hsl(216 34% 17%)` |
| `--ring` | Focus rings | `hsl(220 90% 56%)` | `hsl(213 94% 68%)` |

### Status Colors

| Status | Color | Usage |
|--------|-------|-------|
| Running | `green-500` | AI actively working |
| Thinking | `blue-500` | AI planning/analyzing |
| Waiting | `yellow-500` | Needs user input |
| Paused | `orange-500` | User paused execution |
| Error | `red-500` | Something went wrong |
| Idle | `gray-400` | No active task |
| Success | `green-500` | Task completed |

### Color Usage Guidelines

1. **Never rely on color alone** - Always pair with icons, text, or patterns
2. **Maintain contrast** - 4.5:1 minimum for text, 3:1 for UI elements
3. **Be consistent** - Same meaning = same color throughout
4. **Respect dark mode** - Colors may need adjustment, not just inversion

---

## Typography

### Font Stack

```css
--font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 
             "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, 
             "Liberation Mono", monospace;
```

### Type Scale

| Name | Size | Line Height | Usage |
|------|------|-------------|-------|
| `text-xs` | 12px | 16px | Timestamps, fine print, badges |
| `text-sm` | 14px | 20px | Secondary text, labels, metadata |
| `text-base` | 16px | 24px | Body text, inputs (mobile minimum) |
| `text-lg` | 18px | 28px | Emphasized body text |
| `text-xl` | 20px | 28px | Section headers |
| `text-2xl` | 24px | 32px | Page titles |
| `text-3xl` | 30px | 36px | Hero text (rare) |

### Font Weights

| Weight | Usage |
|--------|-------|
| `font-normal` (400) | Body text, descriptions |
| `font-medium` (500) | Labels, emphasized text |
| `font-semibold` (600) | Headers, buttons |
| `font-bold` (700) | Strong emphasis (rare) |

### Typography Guidelines

1. **16px minimum on mobile** - Anything smaller requires pinch-zoom
2. **Comfortable line lengths** - 45-75 characters for body text
3. **Hierarchy through size** - Reserve weight changes for emphasis
4. **Monospace for code** - Always use `font-mono` for code, paths, IDs

---

## Spacing

### Spacing Scale

Based on 4px grid (Tailwind default):

| Token | Value | Usage |
|-------|-------|-------|
| `1` | 4px | Icon-to-text gaps |
| `2` | 8px | Tight element grouping |
| `3` | 12px | Standard component padding |
| `4` | 16px | Card padding, section gaps |
| `6` | 24px | Major component separation |
| `8` | 32px | Section separation |
| `12` | 48px | Page sections |
| `16` | 64px | Major page breaks |

### Spacing Principles

1. **Consistent rhythm** - Related items share spacing values
2. **Breathe** - Whitespace is intentional, not leftover
3. **Touch targets** - 44x44px minimum on mobile
4. **Platform density** - Desktop can be denser than mobile

---

## Layout

### Breakpoints

| Name | Width | Typical Devices |
|------|-------|-----------------|
| `xs` | < 640px | Small phones |
| `sm` | 640px+ | Large phones |
| `md` | 768px+ | Tablets portrait |
| `lg` | 1024px+ | Tablets landscape, small laptops |
| `xl` | 1280px+ | Laptops, desktops |
| `2xl` | 1536px+ | Large monitors |

### Layout Patterns

#### Mobile (xs, sm)
- Single column layouts
- Bottom navigation
- Stacked cards
- Full-width inputs
- Floating action buttons

#### Tablet (md, lg)
- Master-detail patterns
- 2-column grids
- Sidebar navigation (collapsible)
- Modal dialogs (centered)

#### Desktop (xl, 2xl)
- Multi-column layouts
- Persistent sidebars
- Inline editing
- Split views
- Keyboard-first interactions

### Container Widths

```css
/* Max widths for centered content */
max-w-sm   /* 384px - Narrow forms */
max-w-md   /* 448px - Cards, dialogs */
max-w-lg   /* 512px - Medium content */
max-w-xl   /* 576px - Wide cards */
max-w-2xl  /* 672px - Content areas */
max-w-4xl  /* 896px - Main content */
max-w-6xl  /* 1152px - Wide layouts */
max-w-7xl  /* 1280px - Maximum width */
```

---

## Components

### Component Hierarchy

```
Primitives (shadcn/ui)
├── Button, Input, Label
├── Card, Dialog, Dropdown
├── Tabs, Select, Switch
└── Skeleton, Avatar, Badge

Composed Components
├── SessionCard, ProjectCard
├── ChatMessage, ChatInput
├── StatusIndicator, ProgressStep
└── PermissionRequest, ActionCard

Page Layouts
├── ProjectLayout
├── ChatLayout
├── SettingsLayout
└── SetupWizard
```

### Component States

Every interactive component must handle:

| State | Visual Treatment |
|-------|------------------|
| Default | Base appearance |
| Hover | Subtle highlight (desktop only) |
| Focus | Visible ring (keyboard navigation) |
| Active | Pressed/selected appearance |
| Disabled | Reduced opacity, no interaction |
| Loading | Spinner or skeleton |
| Error | Destructive color, error message |
| Success | Success indication (transient) |

### Animation Principles

1. **Purpose** - Animation communicates, not decorates
2. **Speed** - 150-300ms for micro-interactions
3. **Easing** - `ease-out` for entrances, `ease-in` for exits
4. **Respect motion** - Honor `prefers-reduced-motion`
5. **Performance** - Only animate `transform` and `opacity`

```css
/* Standard transitions */
transition-all duration-200 ease-out  /* Default */
transition-colors duration-150        /* Hover states */
transition-transform duration-300     /* Layout changes */
```

---

## Iconography

### Icon System

- **Style**: Outlined icons (consistent stroke width)
- **Size**: 16px (sm), 20px (default), 24px (lg)
- **Source**: Lucide icons (consistent with shadcn/ui)

### Icon Usage

| Context | Icon Size |
|---------|-----------|
| Inline with text | 16px |
| Buttons | 16-20px |
| Navigation | 20-24px |
| Feature icons | 24px |
| Empty states | 48px+ |

### Icon + Text Pairing

```svelte
<!-- Icon leading -->
<Button>
  <PlusIcon class="size-4 mr-2" />
  Add Project
</Button>

<!-- Icon only (requires label) -->
<Button size="icon" aria-label="Settings">
  <SettingsIcon class="size-4" />
</Button>
```

---

## Patterns

### Loading States

```svelte
<!-- Skeleton for known structure -->
<Skeleton class="h-4 w-3/4" />
<Skeleton class="h-4 w-1/2" />

<!-- Spinner for unknown duration -->
<Loader2 class="size-4 animate-spin" />

<!-- Progress for known progress -->
<Progress value={65} />
```

### Empty States

```svelte
<div class="flex flex-col items-center justify-center py-12 text-center">
  <FolderOpen class="size-12 text-muted-foreground mb-4" />
  <h3 class="font-medium">No projects yet</h3>
  <p class="text-sm text-muted-foreground mt-1 mb-4">
    Create your first project to get started
  </p>
  <Button>Create Project</Button>
</div>
```

### Error States

```svelte
<Alert variant="destructive">
  <AlertCircle class="size-4" />
  <AlertTitle>Connection failed</AlertTitle>
  <AlertDescription>
    Unable to connect to the server. Check your network and try again.
  </AlertDescription>
  <Button variant="outline" size="sm" onclick={retry}>
    Retry
  </Button>
</Alert>
```

### Permission Requests

```svelte
<Card class="border-l-4 border-l-yellow-500">
  <CardHeader class="pb-2">
    <CardTitle class="text-sm flex items-center gap-2">
      <ShieldAlert class="size-4" />
      Permission Required
    </CardTitle>
  </CardHeader>
  <CardContent class="text-sm">
    AI wants to edit <code>src/api/client.ts</code>
  </CardContent>
  <CardFooter class="flex gap-2">
    <Button size="sm">Allow</Button>
    <Button size="sm" variant="outline">Deny</Button>
    <Button size="sm" variant="ghost">Always Allow</Button>
  </CardFooter>
</Card>
```

---

## Accessibility

### Requirements

- WCAG 2.1 Level AA compliance
- Full keyboard navigation
- Screen reader support
- Reduced motion support
- High contrast support

### Implementation Checklist

- [ ] All images have alt text
- [ ] Form inputs have labels
- [ ] Focus indicators are visible
- [ ] Color contrast meets 4.5:1
- [ ] Interactive elements are keyboard accessible
- [ ] ARIA attributes used correctly
- [ ] Announcements for dynamic content

---

## Platform Considerations

### iOS (Tauri Mobile)

- Safe area insets for notch/home indicator
- System font rendering
- Haptic feedback for confirmations
- Swipe gestures for navigation
- Pull-to-refresh patterns

### Android (Tauri Mobile)

- Material-inspired patterns where appropriate
- Back button handling
- Navigation bar considerations
- Different safe area handling

### macOS / Windows / Linux (Tauri Desktop)

- Window chrome integration
- Menu bar menus
- Drag regions for custom titlebars
- Keyboard shortcuts (Cmd/Ctrl aware)
- Multi-window support

---

## Voice & Tone

### Writing Principles

1. **Clear over clever** - No jargon, no puns
2. **Concise** - Every word earns its place
3. **Helpful** - Guide, don't scold
4. **Confident** - Declarative, not tentative
5. **Human** - Warm but professional

### Message Templates

| Context | Tone | Example |
|---------|------|---------|
| Success | Celebratory | "Project created successfully" |
| Error | Helpful | "Couldn't connect. Check your network." |
| Warning | Cautious | "This will delete 3 files. Continue?" |
| Info | Neutral | "Changes synced 2 minutes ago" |
| Loading | Active | "Analyzing project structure..." |

---

## File Organization

```
src/
├── lib/
│   ├── components/
│   │   └── ui/                 # shadcn primitives
│   │       ├── button/
│   │       ├── card/
│   │       └── ...
│   └── styles/
│       └── design-tokens.css   # CSS custom properties
├── app.css                     # Global styles + Tailwind
└── routes/
    └── +layout.svelte          # Root layout with theme
```

---

*This document is a living guide. Update as the design system evolves.*
