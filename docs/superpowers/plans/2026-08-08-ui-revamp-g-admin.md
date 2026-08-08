# UI Revamp Plan G — Admin & Final Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 792-line admin users monolith onto DataTable + shared dialogs + Field, restyle the admin layout/detail pages, close the Plan F ride-alongs, and finish with the final atmosphere purge — app.css drops to ~855 lines and zero cyber/atmosphere classes remain in the codebase.

**Architecture:** Plan G (spec sweep step 7), the last phase before the E–G PR. Verified facts (survey 2026-08-08): admin's 4 files are the SOLE remaining atmosphere consumers; the ban + role dialogs are duplicated verbatim across list/detail pages; `admin/+page.svelte` is a client-side redirect stub; the detail page's test mocks ONLY `getUser/banUser/unbanUser/updateUserRole` from `$lib/api/admin` (children must not import beyond that set) and its hard hooks are `data-testid="ban-user"` / `"change-role"` + email text; the users list has NO tests; DataTable is client-paginated — admin needs opt-in `manualPagination`; `checkIsAdmin` has 3 production console.logs; zero-consumer CSS already deletable: `.status-stopped/-starting/-stopping/-sleeping` + `pulse-slow`, `.stagger-1..3`, `.terminal-prefix` (~60 lines).

**Decisions locked here:** the six zero-consumer admin API functions (limits ×2, audit log, agent catalog ×3) stay untouched — no new screens (YAGNI), no pruning (backend surface may be consumed elsewhere later). Admin table columns are `enableSorting: false` across the board (server-side sorting is unwired; per-page client sorting would silently sort only the visible page — a correctness trap). Role badge stays a plain Badge (roles aren't statuses).

**Tech Stack:** As before. Baseline: 412 tests / 43 files green, HEAD `78e4483`, app.css 1146 lines.

## Global Constraints

- Commands from `apps/console/` in the worktree. After every task: `pnpm check` 0 errors, full `pnpm test` green, output pristine.
- The detail-page test contract is inviolable: mock set (4 admin fns), `data-testid="ban-user"`/`"change-role"` present, email rendered as text.
- Status tokens only; `banned → error`, `active → running` semantics via `tokenFor` aliases (Task 1). `font-mono text-xs uppercase tracking-wider` triplet is eliminated from admin (mono stays only on data: ids, emails ok in mono, dates).
- CSS deletions grep-gated per class, keyframes die with their last reference; the `--status-*` TOKEN system (`text-status-*` utilities, `status-badge.ts`, store mapping) is a separate living system — never touch it in the purge.
- Conventional commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never touch `develop` or the main checkout.

---

### Task 1: Quick wins + Plan F ride-alongs

**Files:**
- Modify: `apps/console/src/app.css` (delete zero-consumer set: `.status-stopped` block + `.dark` variant ~1033-1045, `.status-starting/.status-stopping` ~1047-1056, `.status-sleeping` ~1069-1079, `@keyframes pulse-slow` ~1081-1090, `.stagger-1..3` ~900-902, `.terminal-prefix::before` ~1103-1108 — grep-gate each)
- Replace: `apps/console/src/routes/admin/+page.svelte` → `apps/console/src/routes/admin/+page.ts` with `import { redirect } from "@sveltejs/kit"; export function load() { throw redirect(307, "/admin/users"); }` (SvelteKit 2: `redirect()` may be called without throw — use the idiom the installed version documents; the layout guard still protects the target)
- Modify: `apps/console/src/routes/login/+page.svelte` (~line 176: `text-chart-2` Circle → `statusTextClass("connected")` from `$lib/utils/status-badge`)
- Modify: `apps/console/src/lib/utils/status-badge.ts` + its test (add `active` → running and `banned` → error aliases to `tokenFor`)
- Modify: `apps/console/src/lib/components/theme-settings.svelte` (residuals: two old-style `Select.Trigger` literals ~155/264 → plain trigger; glow `shadow-[0_0_8px_var(--primary)]` check bubbles ~212-213/328-329 → no shadow, and `text-black` → `text-primary-foreground`)
- Modify: `apps/console/src/lib/components/ui/ConfirmDialog.svelte` (add optional `destructive?: boolean` prop → confirm Button `variant="destructive"`; default false) + use `destructive` in theme-settings' delete confirm; extend its test if one exists (theme-settings test asserts the flow — keep green)
- Modify: `apps/console/src/lib/api/admin.ts` (remove the 3 `console.log`s in `checkIsAdmin` ~248-254)

- [ ] **Step 1:** TDD where testable (status-badge aliases RED first; ConfirmDialog destructive prop asserted via theme-settings test or a small new case). CSS deletions grep-gated.
- [ ] **Step 2:** Full gate (`check`, `test`, `build`). Commit `chore(console): admin quick wins — redirect load, status aliases, ride-along polish`.

---

### Task 2: DataTable server-side pagination

**Files:**
- Modify: `apps/console/src/lib/components/ui/data-table/data-table.svelte` + `data-table.test.ts`

**Interfaces:**
- New optional props: `manualPagination?: boolean` (default false), `pageCount?: number`, `pageIndex?: number` (bindable), `onPageChange?: (pageIndex: number) => void`. When `manualPagination` is true: pass `manualPagination: true` + `pageCount` into the TanStack options, drive the footer from the bound `pageIndex`/`pageCount` (footer shows when `pageCount > 1` even though `data` holds one page), and Next/Previous call `onPageChange(newIndex)` instead of `table.nextPage()` mutating local state (or via TanStack's onPaginationChange — implementer's choice, but the observable contract is exactly: buttons disabled at bounds, `onPageChange` fired with the target index, no client re-slicing of `data`).
- Existing client-side behavior unchanged when the prop is absent (all current tests keep passing untouched).

- [ ] **Step 1:** RED — new tests: manual mode renders footer with server pageCount despite short data; Next fires `onPageChange(1)`; Previous disabled at 0; client mode regression-guarded (existing tests untouched).
- [ ] **Step 2:** Implement; full gate. Commit `feat(console): DataTable manual server-side pagination mode`.

---

### Task 3: Shared admin components

**Files (all new unless noted):**
- `apps/console/src/lib/components/admin/BanUserDialog.svelte` + test — props `{open: bindable, user: {id, name?, email} | null, onBanned: () => void}`; required reason via `Textarea` (`$lib/components/ui/textarea`) with a properly-wired `Label for`; calls `banUser(user.id, reason)`; destructive confirm button; toast on error stays inside.
- `apps/console/src/lib/components/admin/RoleDialog.svelte` + test — props `{open: bindable, user: … | null, onChanged: () => void}`; role Select; admin-elevation warning; calls `updateUserRole`.
- `apps/console/src/lib/components/admin/CreateUserDialog.svelte` + test — props `{open: bindable, onCreated: () => void}`; 4 `Field`s with client validation NEW: email format (`type="email"` + simple regex check), password `minlength 8` enforced in the submit guard with `Field error` display; calls `createUser`.
- `apps/console/src/lib/components/admin/AdminStats.svelte` — props `{stats: AdminStats}`; 4 crisp stat tiles (HealthPanel vocabulary). (Skip the free 6-tile sandbox expansion — YAGNI.)
- `apps/console/src/lib/components/admin/UserFilters.svelte` — bindables `searchQuery/roleFilter/bannedFilter` + `onSearch/onRefresh` + `isLoading`; label lookup map replaces the nested ternaries.
- `apps/console/src/lib/components/admin/AdminSettingsBar.svelte` — `signupEnabled` + `onToggle` + `onCreateUser`; the hand-rolled ToggleLeft/Right icons → the `Switch` primitive.
- `apps/console/src/lib/utils/format-date.ts` + test — `formatDate(iso: string, style?: "short" | "long"): string` consolidating the two page-local variants (copy their exact Intl configs).
- CONSTRAINT: these components import ONLY `banUser`/`updateUserRole`/`createUser` from `$lib/api/admin` (the detail-page mock covers banUser/updateUserRole; CreateUserDialog is list-page-only so createUser is fine there — but BanUserDialog/RoleDialog must not import anything beyond the detail mock's set).

- [ ] **Step 1:** RED — dialog tests (open renders, validation blocks, api called with right args on confirm, onX callback after success). Component code follows the current dialogs' behavior exactly (read both copies; where they differ — e.g. Label vs raw label — take the better one).
- [ ] **Step 2:** GREEN + full gate. Commit `feat(console): shared admin dialogs, stats, filters, settings bar`.

---

### Task 4: Admin layout + user detail restyle

**Files:**
- Modify: `apps/console/src/routes/admin/+layout.svelte` — loading branch → centered `Spinner size="lg"` + `Verifying access…` (no typing-cursor/atmosphere); denied branch → `Empty` (ShieldOff icon, title `Access denied`, description = the error text, action = Button link `Return to home`); pass-through unchanged.
- Modify: `apps/console/src/routes/admin/users/[id]/+page.svelte` — atmosphere off; loading → Skeletons; error → standard error card + Retry; user card → crisp `rounded-lg border bg-card p-6`; hand-rolled `status-indicator` pair → `PageHeader status` prop (`{label: "Banned", variant: "error"}` when banned else `{label: "Active", variant: "running"}`) AND/OR an in-card `Badge` via `statusBadgeClass(user.banned ? "banned" : "active")` — pick PageHeader status for the page-level signal, Badge in the identity row; replace both inline dialogs with the shared `BanUserDialog`/`RoleDialog`; meta grid keeps mono ids/dates via `formatDate(…, "long")`. TEST CONTRACT: keep `data-testid="ban-user"`/`"change-role"`, email as text, and do not import beyond the 4-fn mock set.

- [ ] **Step 1:** Existing 3 detail tests stay green (they're forgiving — verify, don't weaken); add one: banned user renders the Banned status label.
- [ ] **Step 2:** Full gate. Commit `feat(console): crisp admin layout and user detail on shared dialogs`.

---

### Task 5: Admin users list rebuild

**Files:**
- Rewrite: `apps/console/src/routes/admin/users/+page.svelte` (792 → target ≤ 250 lines as orchestrator)
- Create: `apps/console/src/routes/admin/users/page.svelte.test.ts` (FIRST tests for the monolith)

Requirements:
1. Compose: `PageHeader` (subtitle `User management`, Create User button into `actions`), `AdminStats`, `AdminSettingsBar`, `UserFilters`, then `DataTable` in `manualPagination` mode (`pageCount` from server total, `onPageChange` → `goToPage` refetch; `filterValue` NOT bound — filters are server-side via UserFilters), `rowTestId="user-row"`.
2. Columns (all `enableSorting: false`): User (renderComponent/snippet: avatar-or-initial + name/email, cell content wrapped in a real `<a href="/admin/users/{id}">` — not a button); Role (snippet: clickable Badge opening RoleDialog); Status (Badge via `statusBadgeClass(banned ? "banned" : "active")`, labels `Banned`/`Active`); Joined (`formatDate(short)`); Actions (snippet: Ban/Unban + View buttons — View also `<a>`-based).
3. Empty via DataTable `emptyTitle="No users found"` + `emptyDescription` distinguishing filtered vs unfiltered (compute from active filters); loading → Skeleton rows above/instead of the table (runtimes precedent); error → standard error card + Retry.
4. All dialogs are the shared components; signup toggle via AdminSettingsBar; the `font-mono uppercase tracking-wider` triplet is gone from the file.
5. New tests (mock `$lib/api/admin` comprehensively for THIS file): renders users from listUsers; ban button opens dialog and `banUser` fires on confirmed reason; role badge opens role dialog; signup toggle calls enable/disableSignup; pagination Next calls listUsers with the next offset; create-user flow validates password length before calling createUser.

- [ ] **Step 1:** RED (new test file) → **Step 2:** rebuild → GREEN + full gate. Commit `feat(console): admin users on DataTable — decomposed, tested, crisp`.

---

### Task 6: Final atmosphere purge + Plan G gate (controller-run finish)

**Files:**
- Modify: `apps/console/src/app.css` — delete, grep-gated: `.noise-overlay` + `--noise-opacity` vars (~820-839), `.grid-bg`/`.dark .grid-bg` (~842-853), `.mesh-gradient`/`.dark` (~856-868), `fade-in-up`/`fade-in` keyframes + `.animate-*` (~875-897), `pulse-dot` keyframes + `.animate-pulse-dot` (~905-918), `blink` + `.typing-cursor` (~921-930), `.cyber-card` full block (~936-981), `.corner-accent` (~984-1003), `.status-indicator`/`.status-running`/`.status-error`/`.status-dot` (~1009-1096 remnants), and the atmosphere selectors inside the shared transition block (~763-765 and ~801-804 ONLY — the generic element/`[data-slot]`/`[role]` selectors drive the app-wide theme crossfade and MUST stay).

- [ ] **Step 1 (subagent):** Purge with per-class grep evidence; `pnpm check && pnpm test && pnpm build`; report app.css final line count. Commit `chore(console): delete the cyber design system — final atmosphere purge`.
- [ ] **Step 2 (controller):** Repo-wide verification grep (`cyber-\|noise-overlay\|grid-bg\|mesh-gradient\|corner-accent\|status-indicator\|typing-cursor\|animate-fade\|animate-pulse-dot` over src/ excluding tests/tokens), push, whole-plan review.
