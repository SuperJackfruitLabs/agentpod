# AgentPod Console — Interaction / Forms / Keyboard & Focus Audit

Scope: `apps/console/src`. Method: grepped for interaction patterns (`onclick`, `onkeydown`, `outline-none`, `autocomplete`, `<form`, `beforeunload`, dialogs) then read every file in full: login page, ConfirmDialog/TypeToConfirmDialog, admin dialogs (Create/Ban/Role), FileBrowser + file-tree + file-quick-open, ConfigEditor, Terminal, LogTail, CleanupPanel, HealthPanel, DataTable, AgentTable, StationTree, theme-settings, settings page, admin users list + detail pages, AdminSettingsBar/UserFilters, NewRuntimeDialog, ProvisionedNodeControls, dialog/sheet/tooltip/button primitives, app-shell.

Every finding below was verified by reading the actual source shown at the cited line — nothing here is speculative.

---

## Critical

### 1. ConfigEditor loses unsaved edits with zero warning — Escape, overlay click, "Close", and tab close all discard silently
`apps/console/src/lib/components/stations/ConfigEditor.svelte:88-96` (Close button), `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte:200-205` (`onOpenChange` unconditionally nulls `configEditorPath` when the dialog closes)

Rule: "warn on unsaved changes before navigation (Monaco config editor!)" — explicitly called out in scope.

What happens: `hasChanges` (`ConfigEditor.svelte:31`) tracks dirty state but nothing reads it before closing. The editor lives inside a `Dialog.Root` whose `onOpenChange` fires on **Escape**, **click-outside-overlay**, and the in-component **Close** button — all three paths call `configEditorPath = null` unconditionally, discarding the buffer with no confirm, no toast, nothing. Grepping the whole app for `beforeunload`/`beforeNavigate` turns up only unused mocks (`mocks/app-navigation.ts:9`) — there is no browser-tab-close/refresh guard either. A user who edits a config file, then hits Escape by reflex or clicks outside the modal, loses the edit outright.

Fix sketch: gate `onOpenChange`/Close on `hasChanges` and show the existing `ConfirmDialog` ("Discard changes?"); add a `beforeNavigate`/`beforeunload` guard while `hasChanges` is true.

---

## High

### 2. CreateUserDialog: Enter key does not submit the form — footer buttons live outside `<form>`
`apps/console/src/lib/components/admin/CreateUserDialog.svelte:100-105` (`<form onsubmit>...</form>`) vs `:170-180` (`Dialog.Footer` with the actual submit button, rendered as a **sibling** of `</form>`, not a descendant)

Rule: "Enter submits focused input."

What happens: the 4-field form (name/email/password/role) has no submit control inside it, and `Button` defaults `type="button"` (`lib/components/ui/button/button.svelte:51`) unless explicitly overridden — the footer "Create user" button never opts into `type="submit"`. With more than one field and no in-form submit control, native implicit submission does not fire, so pressing Enter while typing an email or password does nothing; the user must reach for the mouse. Compare to `routes/login/+page.svelte:163` where `Button type="submit"` inside the `<form>` correctly makes Enter work.

Fix sketch: move the footer buttons inside the `<form>` (bits-ui `Dialog.Footer` can be a child), give the submit button `type="submit"`, and let the existing `onsubmit` handler do the work — drop the duplicate footer `onclick={handleSubmit}`.

### 3. File tree destructive/write actions swallow all errors — no toast, no inline message, no rollback
`apps/console/src/lib/components/stations/file-tree.svelte:165-228` — `handleDelete` (168-176), `handleNewItemKeydown` (189-190), `handleRenameKeydown` (217-218), all three `catch { /* TODO: surface error */ }`

Rule: destructive actions need confirmation/undo *and* clear feedback; forms must surface errors.

What happens: delete is gated behind `TypeToConfirmDialog` (good), but if the `del()`/`move()`/`writeFile()`/`mkdir()` call itself fails (permission error, network blip, race), the catch block is empty apart from a `TODO` comment — the UI just resets the target and calls `refresh()` as if nothing happened. A user who deletes a file and hits a backend error sees no error, no undo, and has to notice on their own that the file is still (or isn't) there.

Fix sketch: surface `err.message` via `toast.error(...)` (already the pattern used in every admin dialog in this codebase) in all three catches.

---

## Medium

### 4. Rename input has `outline-none` with no focus replacement at all
`apps/console/src/lib/components/stations/file-tree.svelte:320-326`

Rule: "never `outline: none` without a replacement."

```
class="h-6 w-24 shrink-0 rounded border border-input bg-background px-1 text-[12px] font-mono outline-none"
```
Unlike the sibling "new file/folder" input two blocks up (`:261`, which at least gets `focus:border-ring`), the inline rename `<input>` has no focus ring, no border-color change, nothing — a keyboard user tabbing to or landing in this field (it's `use:autofocus`ed open) gets no visible focus indicator at all.

Fix sketch: add the same `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` classes used everywhere else in this file.

### 5. Every tooltip in the app opens with zero delay (including the very first one)
`apps/console/src/lib/components/ui/tooltip/tooltip-provider.svelte:4` (`delayDuration = 0` default) wired app-wide via `routes/+layout.svelte:72` (`<Tooltip.Provider>` with no override)

Rule: "Tooltips: delay first, instant for subsequent peers."

What happens: `delayDuration` is hard-coded to `0` as the app's global default and never overridden at any call site (`page-header.svelte`, `page-header-test-host.svelte`). Every tooltip — first hover of the session or not — appears instantly, which reads as noisy/flickery on quick mouse passes rather than deliberate.

Fix sketch: default `delayDuration` to something like 400-700ms; bits-ui's `Provider` already gives "instant for subsequent peers" via `skipDelayDuration` for free once a nonzero delay is set.

### 6. CreateUserDialog doesn't focus the first invalid field on failed validation
`apps/console/src/lib/components/admin/CreateUserDialog.svelte:61-65` (`validate()`), `:67-88` (`handleSubmit`)

Rule: "focus first error on submit."

What happens: `validate()` sets `emailError`/`passwordError`, which `Field` renders as red text (`Field.svelte`'s `error` prop), but nothing calls `.focus()` on the offending input. A user who fails validation sees red text appear near the bottom of the dialog with no cue about where to look/type next.

Fix sketch: on validation failure, `document.getElementById("new-user-email")?.focus()` (or a bound element ref) for the first field with an error.

### 7. Missing `autocomplete` attributes on every credential field in the app
Sites: `routes/login/+page.svelte:190-226` (name/email/password), `lib/components/admin/CreateUserDialog.svelte:107-144` (name/email/password)

Rule: "autocomplete + meaningful name + correct type/inputmode."

`grep -rn "autocomplete"` across `routes` and `lib/components` returns **zero** hits. The login form's email/password inputs (and signup's name field) have correct `type=` but no `autocomplete="email"`/`"current-password"`/`"new-password"`/`"name"`, so password managers and iOS/Android autofill can't reliably target them.

Fix sketch: add `autocomplete="email"` / `autocomplete={authMode === "signin" ? "current-password" : "new-password"}` / `autocomplete="name"` to the three login inputs; same for CreateUserDialog's admin-created-user form.

### 8. Loading buttons change label text only — no spinner icon, despite a `Spinner` component existing
Sites: `lib/components/admin/CreateUserDialog.svelte:178` ("Creating…"), `BanUserDialog.svelte:94` ("Banning…"), `RoleDialog.svelte:108` ("Updating…"), `lib/components/fleet/NewRuntimeDialog.svelte:164` ("Creating…"), `lib/components/stations/ConfigEditor.svelte:105` ("Saving…"), `lib/components/fleet/ProvisionedNodeControls.svelte:94/106/116` ("Destroying…"/"Stopping…"/"Starting…"), `lib/components/fleet/AgentTable.svelte:296` ("Updating…")

Rule: "loading buttons show spinner AND keep label."

`grep -rln "Spinner"` shows the `Spinner` component (`lib/components/ui/spinner`) is used only in `routes/+layout.svelte`, `routes/admin/+layout.svelte`, and `routes/login/+page.svelte` — every action button listed above relies on label-swap alone with no visual spinner, which is a weaker and less-consistent pending signal than the login form sets.

Fix sketch: drop `<Spinner size="sm" />` into these buttons alongside the existing label swap (same pattern as `login/+page.svelte:165,230`).

### 9. Several action buttons give literally zero pending feedback — not even a label change
Sites: `lib/components/stations/HealthPanel.svelte:216-239` (Start/Stop/Restart — only `disabled` toggles, label stays static), `routes/admin/users/[id]/+page.svelte:157-160` (Unban), `routes/admin/users/+page.svelte:191-194` (Unban/Ban in `actionsCell`)

Rule: "Optimistic UI or clear pending feedback for actions (start/stop/restart runtime… user admin actions)."

These are strictly worse than finding #8: the button just becomes non-interactive (`disabled={actionInFlight}` / `disabled={actionLoading}`) with no label change and no spinner, so a slow request looks indistinguishable from a stuck/broken button.

Fix sketch: at minimum swap the label ("Starting…"/"Stopping…"/"Restarting…"/"Unbanning…") the way `ProvisionedNodeControls.svelte` already does for its own Start/Stop/Destroy buttons.

### 10. No `overscroll-behavior: contain` on the shared Dialog primitive
`apps/console/src/lib/components/ui/dialog/dialog-content.svelte:30-33`

Rule: "overscroll-behavior: contain in modals/drawers."

The base `dialog-content.svelte` class list has no `overscroll-contain`. Most dialogs in this app are short and don't scroll, but `ConfigEditor`'s host dialog is `h-[80vh]` (`routes/.../+page.svelte:207`) with internal scroll regions (Monaco + diff pane) — without containment, scrolling to the top/bottom edge of those inner regions can chain to scrolling the page behind the modal.

Fix sketch: add `overscroll-contain` to `dialog-content.svelte`'s base class (and `sheet-content.svelte`, currently unused but worth fixing at the source for when it is).

---

## Low

### 11. StationTree expand/collapse chevron is a 20px hit target
`apps/console/src/lib/components/stations/StationTree.svelte:54-65` — `class="flex items-center justify-center w-5 h-5 p-0 ..."`

Rule: "Hit targets ≥24px."

`w-5 h-5` = 20×20px, below the 24px desktop minimum, with no padding to compensate (contrast with the app's `Button` `icon-xs` size which is a deliberate 24px / `size-6`, `apps/console/src/lib/components/ui/button/button.svelte:23`).

Fix sketch: bump to `w-6 h-6` (matches `icon-xs`) or wrap in a larger invisible hit-area.

### 12. theme-settings.svelte "save theme name" input doesn't submit on Enter
`apps/console/src/lib/components/theme-settings.svelte:404-411`

Rule: "Enter submits focused input."

The `Input` bound to `customThemeName` has no `<form>` wrapper and no `onkeydown` handler; pressing Enter after typing a name does nothing — only clicking the "Save" button beside it works.

Fix sketch: add `onkeydown={(e) => e.key === "Enter" && handleSaveCustomTheme()}` (same pattern already used in `UserFilters.svelte:63`).

### 13. "Public signup" label text isn't wired to the Switch — clicking the words does nothing
`apps/console/src/lib/components/admin/AdminSettingsBar.svelte:28-34`

Rule: "label+control share one hit target."

```
<span class="text-xs text-muted-foreground">Public signup</span>
<Switch checked={signupEnabled} onCheckedChange={onToggle} disabled={signupLoading} />
```
The label is a plain `<span>`, not a `<Label for="...">` bound to the switch's id, so only the small switch pill itself is clickable — the adjacent, larger text label is dead space.

Fix sketch: swap `<span>` for `<Label for="signup-switch">` and add `id="signup-switch"` to the `Switch`.

---

## What's already good

- **Destructive-action confirmation is consistent and strong**: file delete, runtime destroy, station stop/restart, and cleanup-apply all go through `TypeToConfirmDialog` (type-the-exact-name-to-confirm), a meaningfully higher bar than a plain "Are you sure?" — `file-tree.svelte`, `ProvisionedNodeControls.svelte`, `HealthPanel.svelte`, `CleanupPanel.svelte`.
- **Button hit-target scale is compliant**: every `Button` size from `icon-xs` (24px) up is ≥24px (`button.svelte:17-26`), consistently used across the whole app instead of ad-hoc small buttons.
- **Mobile input zoom is correctly prevented**: `Input`/`Textarea` use `text-base` (16px) with `md:text-sm` only kicking in above the mobile breakpoint (`input.svelte:28`, `textarea.svelte:18`).
- **`outline-none` is almost always paired with a real focus-visible ring** (login, search boxes in Terminal/LogTail/AgentTable/Activity/UserFilters, Buttons, Selects) — the file-tree rename input (finding #4) is the one clear exception found.
- **Keyboard-reachable hover actions**: FileBrowser tab-close and file-tree rename/delete buttons use `focus:opacity-100` alongside `group-hover:opacity-100`, so keyboard-focused controls aren't invisible the way hover-only UI often is.
- **Custom sortable table headers are real `<button>`s** wired to Enter/Space with `aria-sort` on the `<th>` (`data-table.svelte:121-139`, `AgentTable.svelte:304-317`) — solid roll-your-own ARIA instead of a div-with-onclick.
- **Connection-loss UX in Terminal/LogTail** is a genuine "clear pending feedback" implementation: visible status dot + label + backoff + manual Reconnect/Retry button, not a silent hang.
- **bits-ui primitives (Dialog/Select/Command/Tabs) are used almost everywhere** instead of hand-rolled overlays, so focus-trap and return-focus are inherited for free across nearly the whole app — the audit found no hand-rolled modal that reimplements focus trapping incorrectly.
