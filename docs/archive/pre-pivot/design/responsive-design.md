# Responsive Design Plan

**Application:** AgentPod - Portable Command Center  
**Date:** December 2024  
**Status:** Implementation Ready

---

## Executive Summary

Transform AgentPod from a desktop-first application into a truly **adaptive cross-platform experience** that feels native on phones, tablets, and desktops. This plan prioritizes mobile-first thinking while progressively enhancing for larger screens.

### Key Principle

> **All changes are frontend-only.** No backend, API, or database modifications required.

---

## Current State Assessment

| Page | Current Responsive State | Mobile Priority | Effort |
|------|--------------------------|-----------------|--------|
| Dashboard (`/`) | Partial | 🔴 High | Medium |
| Login (`/login`) | Good ✅ | 🟢 Low | Low |
| Projects List (`/projects`) | Good ✅ | 🟡 Medium | Low |
| New Project (`/projects/new`) | Good ✅ | 🟢 Low | Low |
| Project Layout (`[id]/+layout`) | Partial | 🔴 High | Medium |
| Chat (`[id]/chat`) | Poor ❌ | 🔴 **Critical** | High |
| Files (`[id]/files`) | Poor ❌ | 🔴 **Critical** | High |
| Logs (`[id]/logs`) | Good ✅ | 🟢 Low | Low |
| Terminal (`[id]/terminal`) | Acceptable | 🟡 Medium | Medium |
| Git Sync (`[id]/sync`) | Good ✅ | 🟢 Low | Low |
| Project Settings (`[id]/settings`) | Good ✅ | 🟢 Low | Low |
| Global Settings (`/settings`) | Partial | 🟡 Medium | Medium |

---

## Breakpoint Strategy

Using Tailwind CSS default breakpoints:

| Breakpoint | Width | Target Devices | Layout Strategy |
|------------|-------|----------------|-----------------|
| `xs` | < 640px | Small phones | Single column, bottom nav, stacked |
| `sm` | ≥ 640px | Large phones | Single column, bottom nav |
| `md` | ≥ 768px | Tablets (portrait) | Master-detail, collapsible sidebar |
| `lg` | ≥ 1024px | Tablets (landscape), laptops | Multi-column, sidebar |
| `xl` | ≥ 1280px | Desktops | Full layout, persistent sidebar |
| `2xl` | ≥ 1536px | Large monitors | Maximum content width |

### Navigation Pattern by Breakpoint

```
Mobile (< md):     Bottom navigation bar
Tablet (md-lg):    Collapsible sidebar + header
Desktop (≥ lg):    Persistent sidebar + header
```

---

## Phase 1: Foundation

**Duration:** Week 1  
**Goal:** Create core responsive infrastructure

### 1.1 New Components to Create

#### BottomNav Component
**Path:** `src/lib/components/bottom-nav.svelte`

```svelte
<!-- Structure -->
<nav class="fixed bottom-0 inset-x-0 md:hidden bg-background border-t safe-area-pb">
  <div class="flex justify-around items-center h-16">
    <BottomNavItem href="/" icon={Home} label="Home" badge={attentionCount} />
    <BottomNavItem href="/projects" icon={Folder} label="Projects" />
    <BottomNavItem href="/activity" icon={Activity} label="Activity" />
    <BottomNavItem href="/settings" icon={Settings} label="Settings" />
  </div>
</nav>
```

**Features:**
- Fixed to bottom on mobile only (`md:hidden`)
- Safe area handling for iOS home indicator
- Badge support for notification counts
- Active state highlighting
- 44px minimum touch targets

#### Sheet Component (from shadcn/ui)
**Path:** `src/lib/components/ui/sheet/`

Required for mobile slide-out drawers. Add via:
```bash
npx shadcn-svelte@latest add sheet
```

#### AppShell Component
**Path:** `src/lib/components/app-shell.svelte`

```svelte
<!-- Structure -->
<div class="min-h-screen flex flex-col">
  <!-- Main content area with bottom padding for nav on mobile -->
  <main class="flex-1 pb-16 md:pb-0">
    <slot />
  </main>
  
  <!-- Bottom nav (mobile only) -->
  <BottomNav class="md:hidden" />
</div>
```

### 1.2 Global CSS Updates

**File:** `src/app.css`

```css
/* Safe area utilities */
.safe-area-pt { padding-top: env(safe-area-inset-top); }
.safe-area-pb { padding-bottom: env(safe-area-inset-bottom); }
.safe-area-pl { padding-left: env(safe-area-inset-left); }
.safe-area-pr { padding-right: env(safe-area-inset-right); }

/* Touch target minimum */
.touch-target {
  min-height: 44px;
  min-width: 44px;
}

/* Hide scrollbar but keep functionality */
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}

/* Responsive container */
.responsive-container {
  @apply px-4 sm:px-6 lg:px-8;
}
```

### 1.3 Layout Updates

**File:** `src/routes/+layout.svelte`

- Wrap content in AppShell component
- Add bottom padding for mobile nav
- Integrate BottomNav conditionally

### 1.4 Deliverables Checklist

- [ ] Create `bottom-nav.svelte` component
- [ ] Create `bottom-nav-item.svelte` component
- [ ] Add Sheet component from shadcn/ui
- [ ] Create `app-shell.svelte` component
- [ ] Add safe area CSS utilities
- [ ] Update root layout with AppShell
- [ ] Test on mobile viewport sizes

---

## Phase 2: Critical Page Fixes

**Duration:** Week 2  
**Goal:** Fix the two most broken mobile experiences

### 2.1 Chat Page (`/projects/[id]/chat`)

**Current Issues:**
- Fixed 264px sidebar breaks on mobile
- Model/agent selectors cramped
- No mobile-friendly session switching

**Solution Architecture:**

```
Mobile (< md):
┌─────────────────────────┐
│ Header [≡] Project Name │  ← Hamburger opens session drawer
├─────────────────────────┤
│                         │
│     Chat Messages       │
│                         │
├─────────────────────────┤
│ [Model ▼] [Agent ▼]     │  ← Compact selector row
├─────────────────────────┤
│ Message input...    [→] │  ← Docked to bottom
└─────────────────────────┘

Tablet/Desktop (≥ md):
┌──────────┬──────────────────────┐
│ Sessions │ Header               │
│          ├──────────────────────┤
│ • Chat 1 │                      │
│ • Chat 2 │   Chat Messages      │
│ • Chat 3 │                      │
│          ├──────────────────────┤
│ [+ New]  │ Input area           │
└──────────┴──────────────────────┘
```

**Implementation Steps:**

1. **Wrap sidebar in Sheet on mobile:**
```svelte
<!-- Mobile: Slide-out drawer -->
<div class="md:hidden">
  <Sheet.Root bind:open={sidebarOpen}>
    <Sheet.Content side="left" class="w-[280px] p-0">
      <SessionList {sessions} {currentSession} onSelect={handleSelect} />
    </Sheet.Content>
  </Sheet.Root>
</div>

<!-- Desktop: Persistent sidebar -->
<aside class="hidden md:flex w-64 border-r flex-col">
  <SessionList {sessions} {currentSession} onSelect={handleSelect} />
</aside>
```

2. **Add mobile header with drawer trigger:**
```svelte
<header class="md:hidden flex items-center gap-3 p-4 border-b">
  <Button variant="ghost" size="icon" onclick={() => sidebarOpen = true}>
    <Menu class="h-5 w-5" />
  </Button>
  <span class="font-medium truncate">{currentSession?.title || 'New Chat'}</span>
</header>
```

3. **Compact model/agent selectors:**
```svelte
<div class="flex gap-2 p-2 border-t md:hidden">
  <Select compact value={model}>...</Select>
  <Select compact value={agent}>...</Select>
</div>
```

**Deliverables:**
- [ ] Add Sheet component integration
- [ ] Create mobile chat header
- [ ] Implement responsive sidebar (Sheet on mobile, aside on desktop)
- [ ] Compact selector row for mobile
- [ ] Test session switching on mobile

### 2.2 Files Page (`/projects/[id]/files`)

**Current Issues:**
- Fixed 288px file tree sidebar
- Two-panel layout unusable on mobile
- No breadcrumb navigation

**Solution Architecture:**

```
Mobile (< md) - Stack Navigation:

Screen 1: File Tree
┌─────────────────────────┐
│ ← Files                 │
├─────────────────────────┤
│ 📁 src/                 │
│   📁 components/        │
│   📁 routes/            │
│   📄 app.css            │
│ 📁 static/              │
│ 📄 package.json         │
└─────────────────────────┘
        ↓ tap file
        
Screen 2: File Content
┌─────────────────────────┐
│ ← src/app.css           │  ← Breadcrumb path
├─────────────────────────┤
│                         │
│   File content viewer   │
│                         │
└─────────────────────────┘

Tablet/Desktop (≥ md) - Split View:
┌──────────────┬──────────────────────┐
│ File Tree    │ File Content         │
│              │                      │
│ 📁 src/      │ // app.css           │
│   📄 app.css │ @import "tailwind";  │
│              │ ...                  │
└──────────────┴──────────────────────┘
```

**Implementation Steps:**

1. **Create mobile file browser state:**
```svelte
<script>
  let mobileView: 'tree' | 'content' = 'tree';
  let selectedFile: string | null = null;
  
  function selectFile(path: string) {
    selectedFile = path;
    if (window.innerWidth < 768) {
      mobileView = 'content';
    }
  }
  
  function goBack() {
    mobileView = 'tree';
    selectedFile = null;
  }
</script>
```

2. **Conditional rendering based on view:**
```svelte
<!-- Mobile: Stack-based navigation -->
<div class="md:hidden">
  {#if mobileView === 'tree'}
    <FileTree onSelect={selectFile} />
  {:else}
    <div class="flex flex-col h-full">
      <header class="flex items-center gap-2 p-4 border-b">
        <Button variant="ghost" size="icon" onclick={goBack}>
          <ArrowLeft class="h-5 w-5" />
        </Button>
        <span class="text-sm font-mono truncate">{selectedFile}</span>
      </header>
      <FileContent path={selectedFile} />
    </div>
  {/if}
</div>

<!-- Desktop: Split view -->
<div class="hidden md:grid md:grid-cols-[280px_1fr] h-full">
  <FileTree onSelect={selectFile} />
  <FileContent path={selectedFile} />
</div>
```

3. **Add Breadcrumbs component:**
```svelte
<!-- src/lib/components/breadcrumbs.svelte -->
<nav class="flex items-center gap-1 text-sm">
  {#each pathSegments as segment, i}
    {#if i > 0}
      <ChevronRight class="h-4 w-4 text-muted-foreground" />
    {/if}
    <button 
      class="hover:underline truncate max-w-[100px]"
      onclick={() => navigateTo(segment.path)}
    >
      {segment.name}
    </button>
  {/each}
</nav>
```

**Deliverables:**
- [ ] Create mobile file browser view state
- [ ] Implement stack-based navigation for mobile
- [ ] Create Breadcrumbs component
- [ ] Add back navigation with file path display
- [ ] Maintain desktop split-view layout
- [ ] Test file selection flow on mobile

### 2.3 Project Layout (`/projects/[id]/+layout`)

**Current Issues:**
- Tabs overflow on small screens
- Tab labels don't adapt to icons

**Solution:**

```svelte
<!-- Responsive tabs -->
<Tabs.List class="flex overflow-x-auto scrollbar-hide">
  <Tabs.Trigger value="chat" class="flex-shrink-0 gap-2">
    <MessageSquare class="h-4 w-4" />
    <span class="hidden sm:inline">Chat</span>
  </Tabs.Trigger>
  <Tabs.Trigger value="files" class="flex-shrink-0 gap-2">
    <Files class="h-4 w-4" />
    <span class="hidden sm:inline">Files</span>
  </Tabs.Trigger>
  <!-- ... other tabs -->
</Tabs.List>
```

**Deliverables:**
- [ ] Convert tabs to icon-only on mobile
- [ ] Add horizontal scroll for tab overflow
- [ ] Add tooltips for icon-only tabs
- [ ] Test tab navigation on mobile

---

## Phase 3: Secondary Pages

**Duration:** Week 3  
**Goal:** Polish remaining pages

### 3.1 Dashboard (`/`)

**Changes:**
| Element | Mobile | Desktop |
|---------|--------|---------|
| Stats Grid | Horizontal scroll or 2×2 | 1×4 row |
| Active Sessions | Full-width stacked | 2/3 width |
| Recent Projects | Horizontal carousel | 1/3 width |
| Quick Actions | FAB for "New Project" | Inline buttons |

**Deliverables:**
- [ ] Convert stats to horizontal scroll on xs
- [ ] Add FAB for primary action on mobile
- [ ] Implement horizontal project carousel
- [ ] Test dashboard on various screen sizes

### 3.2 Global Settings (`/settings`)

**Changes:**
| Element | Mobile | Desktop |
|---------|--------|---------|
| Tab Navigation | Vertical accordion | Horizontal tabs |
| Form Grids | Single column | 2-3 columns |
| Theme Picker | 2 columns | 4 columns |

**Deliverables:**
- [ ] Convert tabs to accordion/sections on mobile
- [ ] Single-column form layouts
- [ ] Responsive theme picker grid
- [ ] Full-width buttons on mobile

### 3.3 Terminal (`/projects/[id]/terminal`)

**Changes:**
- Handle on-screen keyboard appearance
- Add terminal font size controls
- Scrollable tab bar for multiple terminals

**Deliverables:**
- [ ] Keyboard-aware viewport handling
- [ ] Font size adjustment controls
- [ ] Scrollable terminal tabs

---

## Phase 4: Enhancement & Polish

**Duration:** Week 4  
**Goal:** Add platform-specific enhancements

### 4.1 Gesture Support

- **Pull-to-refresh:** Dashboard, project list, chat
- **Swipe actions:** Project cards (start/stop)
- **Swipe navigation:** Back gesture on file viewer

### 4.2 Platform-Specific Touches

**iOS:**
- Safe area insets (notch, home indicator)
- Haptic feedback on actions
- Native-feeling scroll behavior

**Android:**
- Material-inspired touch feedback
- Back button handling
- Status bar theming

### 4.3 Performance Optimization

- Lazy load off-screen content
- Virtualize long lists (sessions, files)
- Optimize animations for 60fps

### 4.4 Deliverables

- [ ] Implement pull-to-refresh component
- [ ] Add swipe actions to project cards
- [ ] Safe area handling for iOS
- [ ] Test on real mobile devices
- [ ] Performance audit and optimization

---

## New Components Summary

| Component | Path | Priority | Phase |
|-----------|------|----------|-------|
| `bottom-nav.svelte` | `src/lib/components/` | P1 | 1 |
| `bottom-nav-item.svelte` | `src/lib/components/` | P1 | 1 |
| `app-shell.svelte` | `src/lib/components/` | P1 | 1 |
| `sheet/` | `src/lib/components/ui/` | P1 | 1 |
| `breadcrumbs.svelte` | `src/lib/components/` | P1 | 2 |
| `mobile-file-browser.svelte` | `src/lib/components/` | P1 | 2 |
| `fab.svelte` | `src/lib/components/` | P2 | 3 |
| `pull-to-refresh.svelte` | `src/lib/components/` | P3 | 4 |

---

## Files to Modify

| File | Phase | Changes |
|------|-------|---------|
| `src/app.css` | 1 | Safe area utilities, touch targets |
| `src/routes/+layout.svelte` | 1 | AppShell integration, bottom nav |
| `src/routes/projects/[id]/chat/+page.svelte` | 2 | Sheet sidebar, mobile header |
| `src/routes/projects/[id]/files/+page.svelte` | 2 | Stack navigation, breadcrumbs |
| `src/routes/projects/[id]/+layout.svelte` | 2 | Responsive tabs |
| `src/routes/+page.svelte` | 3 | Dashboard responsive grid |
| `src/routes/settings/+page.svelte` | 3 | Accordion tabs, form layouts |
| `src/routes/projects/[id]/terminal/+page.svelte` | 3 | Keyboard handling |

---

## Success Criteria

| Metric | Target | How to Verify |
|--------|--------|---------------|
| Touch targets | ≥ 44×44px | Manual audit of all buttons/links |
| Body text | ≥ 16px on mobile | CSS inspection |
| Navigation depth | ≤ 2 taps to any feature | User flow testing |
| Layout shift | None during resize | Chrome DevTools |
| Keyboard nav | Full support | Tab through all elements |
| Screen reader | Full support | VoiceOver/TalkBack testing |

---

## Testing Checklist

### Viewport Sizes to Test
- [ ] 320px (iPhone SE)
- [ ] 375px (iPhone 12/13 mini)
- [ ] 390px (iPhone 12/13/14)
- [ ] 428px (iPhone 12/13/14 Pro Max)
- [ ] 768px (iPad portrait)
- [ ] 1024px (iPad landscape)
- [ ] 1280px (Laptop)
- [ ] 1536px (Desktop)

### Features to Test per Page
- [ ] Layout doesn't break
- [ ] All content accessible
- [ ] Touch targets adequate
- [ ] Text readable
- [ ] Navigation works
- [ ] No horizontal scroll (unless intended)

---

## Related Documentation

- [06-implementation-plan.md](./06-implementation-plan.md) - Original UX implementation plan
- [10-component-specifications.md](./10-component-specifications.md) - Component specs
- [design-language.md](../design-language.md) - Design system foundation
- [mockups/mobile-mockups.html](./mockups/mobile-mockups.html) - Mobile design mockups

---

*Document created: December 2024*
