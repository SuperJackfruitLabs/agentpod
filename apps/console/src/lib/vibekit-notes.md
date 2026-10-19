# The console on vibekit: decisions

vibekit 0.0.13 is vendored as `vendor/superjackfruit-vibekit-0.0.13.tgz` (a `file:` dependency, as Superpipeline does). Spec: `docs/superpowers/specs/2026-10-19-console-on-vibekit-design.md`. Each later part adds its decisions here.

## Part 0: foundation

### Appearance replaces the theme system

- Removed: the theme store (`src/lib/themes/**`: 20 colour schemes, 20 font pairings, custom themes, the 18:00 auto-dark rule), `theme-settings.svelte`, `mode-watcher`, the dead `cyber-*` props, `scripts/contrast-audit.ts` (it audited the removed presets; vibekit owns contrast now), the 21 self-hosted font families (`static/fonts`) and their `@font-face`, and the unreferenced Lottie icons (`static/icons/animated`) and sample workflows (`static/sample-workflows`).
- `src/lib/appearance.svelte.ts` is Superpipeline's store with product `agentpod`: vibe, light / dark / follow the sun, time-of-day strength, location, accent (default `product` = cobalt), in the cookie `vk_appearance` for this host only. Unlike Superpipeline's, it writes every `<html>` attribute (`data-vibe`, `data-theme`, `data-phase`, `data-time`, `data-accent`, `data-product`), so `<html>` is right before the layout mounts; `VibeRoot` writes the same vibe and theme from the store, so the two never disagree.
- The old `agentpod-theme-mode`: `light` or `dark` seeds the cookie once (Daylight, that theme); `system` and `auto` are what following the sun already means, so nothing is written. All four old keys (`agentpod-theme-mode`, `agentpod-color-scheme`, `agentpod-font-pairing`, `agentpod-custom-themes`) are cleared on the first load. The seed runs twice by design: in `app.html` before the first paint and in `appearance.init()` (where it is tested).
- `app.html`: the seed script, then vibekit's `HEAD_SCRIPT` verbatim (the console serves no CSP, so inline is fine), then a first-frame background per vibe and theme. `head-script.test.ts` pins both against the installed vibekit. `data-product="agentpod"` is on `<html>`.
- The Settings page's Appearance section went with the theme settings; Part 2 brings the Appearance control back (account chip menu and Settings).

### Stylesheets

- `app.css` imports `@superjackfruit/vibekit/fonts.css` and `vibekit.css` (the same two files `bundle.css` concatenates; this lets Vite resolve and fingerprint the font files, and matches Superpipeline). vibekit's `tailwind.css` is NOT imported: its `--color-muted`, `--color-accent`, `--font-*`, `--radius-*` mean other things.
- Layer order `theme, base, vk, components, utilities`: a Tailwind class outranks a vibekit default; vibekit outranks the preflight.
- `dark:` is `[data-theme="dark"] *`; there is no `.dark` class anywhere (the Shiki selectors in `code-block` and `markdown-viewer` moved to `[data-theme="dark"]`).

### The compatibility layer (shadcn names -> vibekit tokens)

Declared on `:root, [data-vibe]` so a nested vibe resolves its own values. Fills are mapped deliberately: in shadcn `muted`, `accent`, `secondary` are BACKGROUNDS.

| shadcn | vibekit | why |
|---|---|---|
| background / foreground | `bg` / `text` | direct |
| card, popover | `surface` | the raised sheet in every vibe |
| primary (+fg) | `primary` (+`primary-fg`) | the vibe's ink button |
| secondary, muted | `raised` | neutral fills (hover, zebra, chips) |
| accent | `accent-wash` | shadcn's selected/hover fill; the cobalt wash reads as "selected" |
| muted-foreground | `muted` | secondary text |
| destructive (+fg) | `danger` (+`danger-fg`) | Quiet's danger is ink, not red, by vibekit's design |
| border | `line` | hairline |
| input | `rule` | the stronger line keeps control borders visible (the console's 3:1 rule) |
| ring | `accent` | focus in the product colour |
| brand (+fg, text), new | `accent` (+`accent-fg`, `accent-text`) | the product colour (cobalt), for links and selection |
| chart-1..5 | `stage-1..5` | no chart component exists; kept mapped |
| sidebar* | `surface`, `line`, `accent`, `accent-wash` | the rail is rebuilt in Part 2 |
| fonts: body / heading / mono / Tailwind sans | `font-body` / `font-display` / `font-mono` | the vibe owns the fonts |
| radius sm / md / lg / xl | `radius-sm - 4px` (min 2px) / `radius-sm` / `radius-md` / `radius-lg` | md = controls, lg = cards, xl = dialogs |

Status tokens: running `success`, degraded and unknown `signal`, starting `accent`, stopped `faint`, error `danger`, sleeping a local violet (`--ap-violet`: vibekit has no violet).

Local tones (`--ap-warn*`, `--ap-info*`, Tailwind `warn`, `warn-text`, `warn-wash`, `info`, `info-text`, `info-wash`): hexes from the approved mockups. Daylight's are the default; Paper and Quiet have their own; Studio draws warnings with its signal and info with its accent (its mockups define no local tones). Quiet's mockups give only the stroke colour, so its wash is `raised`.

Type roles (`t-page`, `t-section`, `t-body`, `t-label`, `t-metric`) keep their sizes and take the vibe's fonts (`t-page`/`t-section` display, `t-metric` mono).

### Widgets, until Part 1 themes them from tokens

- The sonner toaster follows `appearance.theme` (it read mode-watcher, which was never mounted). Regression test: `ui/sonner/sonner.svelte.test.ts`.
- Monaco follows `appearance.theme` (`vs` / `vs-dark`). xterm re-reads the CSS variables on a vibe or theme change (they now compute to vibekit hex). Shiki uses the GitHub light/dark pair everywhere (the schemes that named other Shiki themes are gone).

## Part 1: primitives and widgets

### Widgets themed from tokens

- `src/lib/utils/vk-colors.ts`: `tokenHex()` reads a computed vibekit token as `#rrggbb`; `vibePalette()` maps the vibe onto code roles (red = danger, green = success, yellow = signal, blue = accent, magenta = `--ap-violet`, cyan = `--ap-info`, or a blue/green mix where info is the accent, as in Studio). Any role under 4.5:1 on the ground has its HSL lightness moved until it passes (`ensureContrast`). `vk-colors.test.ts` checks all 8 vibe x theme pairs against the real token files (`vk-tokens.fixture.ts` parses vibekit's tokens.css, accents.css and app.css).
- xterm: `terminalTheme()` (16 ANSI colours, hex); the search decorations use signal / accent. Monaco: `monacoTheme()` defined as `agentpod-vibe` and redefined on each change. Both repaint through `onAppearanceChange()`, a MutationObserver on `<html>`'s `data-vibe`/`data-theme`/`data-accent`, so a change that lands inside a view transition still repaints.
- Shiki: one treatment for code blocks, the markdown preview and chat replies: a css-variables theme (`src/lib/utils/shiki-theme.ts`). The `--shiki-*` variables have token defaults on `:root` in app.css (so light/dark is chosen by `[data-theme]` through the tokens, never `.dark`), and `startWidgetColours()` (layout) writes the contrast-checked hex on `<html>` on every change. Highlighted HTML is never re-rendered for a theme change. The code background is `raised` in all three places. code-block's unused `lightTheme`/`darkTheme` props were removed.
- Markdown preview: `render-markdown.ts` sanitises marked's output with DOMPurify 3.4.13 (already in the lockfile through svelte-streamdown; now a direct dependency): no scripts, event handlers, forms, iframes, or non-http(s)/mailto/relative URLs.

### Primitives

- `src/lib/styles/primitives.css` (imported by app.css, unlayered so it outranks the primitives' Tailwind utilities; selectors in `:where()` so they add no specificity) gives every primitive its vibe's look by `data-slot` (Button also exposes `data-variant`/`data-size`): Daylight pill buttons with a lift, raised inputs with a 2px inset line, large radii and soft shadows; Paper small radii, ink-ruled buttons and dialogs, italic serif dialog titles; Studio square, ink primary, mono uppercase table heads; Quiet 2px ink outlines, no shadows. Primary buttons are the product accent in Daylight and Paper, the ink primary in Studio and Quiet (as the mockups draw them). 44px targets on coarse pointers only (desktop density unchanged).
- Status as text: `text-status-*` now reads `--status-*-text` (success-text, signal-text, accent-text, muted, danger, violet), because the fills (Daylight's success `#7fd3a0`) are unreadable as words. Dots, cells and borders keep the fill. Tested at 4.5:1 on bg and surface in all 8 pairs; Studio light needed a darker violet (`#6448b0`).
- One `WarnBox` (`ui/warn-box`) on the local warn tone replaces six hand-built amber boxes; one `DiffLines` (`ui/diff-lines`) on success/danger tokens serves DiffBlock and ConfigEditor. No Tailwind palette colour remains in src.
- The five dialogs with a doubled Portal + Overlay now use Dialog.Content's own.

### Wrap or build (vibekit 0.0.13 component vs the console's)

All kept local and restyled; none switched in this part:

- Dialog / Sheet / Drawer: vibekit's take `title`, `description`, `actions` as props and pick a form per vibe from VibeRoot context; the console composes bits-ui parts (`Dialog.Title`, `Dialog.Footer` ...) in about twenty callers whose tests query `role="dialog"` and named buttons. vibekit renders destructive confirms as `alertdialog`, which the existing tests (and ConfirmDialog's callers) do not expect. Switching is a caller rewrite, not a primitive swap.
- Menu: item-list API (`label`, `onselect`) vs the console's composed dropdown parts with links and checkbox items; kept.
- Tabs, DataTable, CommandPalette: the console's are bits-ui based with link tabs, sortable tables and a command list whose groups and strings the tests pin; the shell and pages are rebuilt in Parts 2+, where these swaps belong.
- Notice: no warning tone (`needs` is the signal colour) and it adds an icon and `role="note"`; WarnBox was built instead.
- EmptyState, Loading, Toast, StateLabel, Face: no caller is touched by this part; svelte-sonner stays (its toaster already follows the theme and reads the token bridge).

## Part 2: shell, navigation, appearance, phone chrome

### What the shell is now

- `AppShell`: one grid, rows head / lane / columns / phone bar (`grid-rows-[auto_auto_minmax(0,1fr)_auto]`, still `h-screen`, the stage still scrolls its own `<main>`). The head holds `TopBar` and `Navigation`; in Daylight it carries the sky (`vk-sky`, phase from the appearance store, the sun at 56%). The three columns are unchanged (roster 272px, stage, context rail 320px at >= 1241px).
- `nav.ts` is the one source for sections (Fleet, Agents, Nodes, Runtimes, Activity, Settings, Admin for admins), the current section by path (a station page is Agents), the phone's four places (More is current for Nodes, Runtimes, Settings, Admin) and what More lists. Admin = `auth.user.role === "admin"` (from `/api/me`'s `isAdmin`).
- `Navigation`: one markup, three looks by `data-vibe` in `src/lib/styles/shell.css`: a row of pills on the sky (Daylight), a serif ruled row with Settings/Admin to the right (Paper), the black ink rail with labelled icons spanning every row at >= 901px (Studio: the head becomes `display: contents`), a plain list of underlined links (Quiet). Current = `aria-current="page"` plus weight and a bar/underline/filled cell, never colour alone. Hidden under 901px.
- `AccountMenu` replaces the top bar's Appearance link, avatar and sign-out button: the chip (initials and email), a disclosure panel (`role="dialog"`, Escape returns focus to the chip, click outside closes) with the email, Appearance (expands `AppearanceControl` in place) and Sign out. Hidden under 901px, where More holds it.
- `AppearanceControl`: vibe (4), Light / Dark / Follow the sun (`sun`), accent (Cobalt product default, then the Superpipeline, Superlibrary and Superwitness colours = gold, plum, jade, as the mockups label them). No time-of-day control. Settings will reuse it in Part 3.
- `PhoneBar` (Fleet, Agents, Activity, More) and `MoreSheet` (console Sheet, bottom side: Nodes, Runtimes, Settings, Admin for admins, Appearance, the account email, Sign out). The roster/stage toggle stays in the top bar.
- `AttentionLane` drops any `permission` item: an approval never shows in the lane (deriveAttention never emits one; the filter makes it a rule, tested).
- Cmd/Ctrl+K moved into `palette-shortcut.ts` (tested); the layout calls it. Sign-out is one helper (`shell/sign-out.ts`).
- Shell styles are CSS (`shell.css`, unlayered, after primitives.css) keyed on `.ap-*` classes and the existing `data-testid`s, and never set `display` on an element whose visibility a responsive utility decides.
- vibekit's accent variables are `--vk-color-accent*` in the console (the mockups' `--vk-accent*` are the canvas's own names).

### Wrap or build

- AppShell, AppNav, Masthead, PhoneTabBar (vibekit): kept local. The console's shell carries behaviour the tests pin (the capped `h-screen` grid with the stage's own scroller, the roster/stage view switch at 900px, the per-route context rail snippet, the shared fleet poll, the attention lane row); vibekit's AppShell lays out a document-scrolling page with its own slots, and AppNav/PhoneTabBar take item lists without the console's section rule (station pages under Agents, More current for four sections). Restyled to the mockups instead.
- AppearancePicker (vibekit): not used. It includes the time-of-day strength and location controls the mockups leave out ("no Time of day control") and lays out as a page section; `AppearanceControl` draws exactly the mockups' three fieldsets.
- Sheet (vibekit): the More sheet uses the console's Sheet (bits-ui dialog, the Part 1 decision).

### Screenshot harness

`e2e/shots.mjs` (playwright-core 1.63.0, the version whose Chromium revision is in the local Playwright cache; nothing is downloaded): serves `build/`, answers the hub with the canonical sample fleet (no plane, so the session comes from `/api/auth/get-session`), fixes the clock at noon, and shoots vibe x theme at 1440x900 and 390x844 into `e2e/shots/` (git-ignored). `--menu` opens the account menu with Appearance expanded, `--more` the More sheet, `--path=` another page.

## Part 3: fleet pages

- `src/lib/styles/pages.css` (unlayered, after shell.css) draws the fleet pages per vibe on a few classes: `.ap-page`, `.ap-card` (a raised card in Daylight, a ruled section in Paper, Studio and Quiet), `.ap-sec-h`/`.ap-h2`, `.ap-tbl`, `.ap-hero`/`.ap-need`/`.ap-figs`, `.ap-feed`, `.ap-ph--plain` (PageHeader without tabs; the station header with tabs is untouched until Part 4), `.ap-nh` (node header), `.ap-kv`, `.ap-alert`, `.ap-auth*`, `.ap-err*`. State tones come from `data-state` on StateDot, StateBar segments and the agent table's status pill.
- Status tones now follow the mockups: unknown wears the local warn tone, starting the local info tone (they were signal and accent). Quiet draws a failed state in its mockups' red (`--ap-danger`) while its destructive buttons keep vibekit's ink.
- Studio's figures (Agents, Running, Nodes online of total, Updates available) are counts the page already has; the other vibes hide them. Studio numbers its section heads with a CSS counter.
- The agent table's status pill colours by `stationState` (so unknown is the unknown tone); the text and the severity sort are unchanged.
- `AuthFrame` (brand) frames boot, sign-in and the sign-in callback: Daylight's sky band, the content over it.
- Defect fixes: `/agents?action=create` opens Create an agent (the palette's command did nothing); the error page offers Reload; a failed sign-in under the plane offers Try again; Settings regains Appearance (the Part 2 control) before Connection, Devices and Account.

### Wrap or build

- Face (vibekit): used in the agent table rows (decorative, `aria-hidden`, beside the link so the link's text stays the name). Mood: running = working, otherwise resting.
- DataTable (vibekit): not used. AgentTable's sort buttons with `aria-sort`, collapsible group rows with a ribbon and the Grouped/Flat and Updates-only toggles are pinned by tests; restyled instead.
- StateLabel (vibekit): not used. Its vocabulary (needs, failed, stopped ...) is not the console's six fleet states, and StateDot's sr-only and title behaviour is tested; StateDot restyled per vibe.
- Notice, EmptyState, Loading: kept the console's `ap-alert`, `Empty` and skeletons (copy and roles pinned); restyled.

## Part 4: station page

- Three widths: >= 1241px the rail is the shell's context column; 901 to 1240px it is the Identity tab (second, after Chat); <= 900px there is no Identity tab and the header gains "About {agent}", which opens a bottom sheet (the console's Sheet) holding the same `ContextRail` plus Restart and Stop. Restart and Stop also stay in the header; every lifecycle button goes through the same confirm (the sheet closes first). An `?tab=identity` link on a phone falls back to the default tab.
- `src/lib/styles/station.css` (unlayered, after pages.css) draws the header, the tab strip (Daylight: pills on a surface card; Paper, Studio, Quiet: an underlined strip, Studio keeps the icons), the chat card, the permission mode chips as a segmented control, the user bubble, tool calls, the permission ask (warn-ringed in Daylight and Paper, ink in Studio and Quiet; 44px options, full width on a phone), the composer, Health (metric tiles) and Logs, the rail (one card per section in Daylight, ruled sections elsewhere, facts as a two-column grid) and the About sheet. Hooks: `.ap-st-*`, `.ap-chat*`, `.ap-modes`, `.ap-bubble`, `.chat-item[data-kind]`, `.ap-perm*`, `.ap-composer`, `.ap-rail*`, `.ap-about*`, `.ap-health`, `.ap-tile`, `.ap-logs`.
- The transcript's words are never restyled into another voice: Paper keeps the body font for the bubble and replies (no letters). A test renders the same transcript in all four vibes and checks the words and the three permission options.
- The header's name keeps its `font-mono` class (a test pins it) while Daylight, Paper and Quiet set it in the display face and Studio in mono, as the mockups draw it.

### Wrap or build

- Face (vibekit): in the station header (Daylight only, decorative, `aria-hidden`); the other vibes and phones show the StateDot as their mockups do.
- Sheet (vibekit): not used for About; the console's Sheet (bits-ui dialog) as for More (Part 2 decision; dialog role and focus trap pinned by tests).
- Tabs (vibekit): not used; the station strip has a roving tabindex, capability gating, a locked Terminal tab and keep-alive panels the tests pin.
- StateLabel, Notice, Loading: not used (HealthPanel's error with Retry, skeletons and status text are pinned); restyled.
- Streamdown/Shiki in replies: the Part 1 treatment, unchanged.

## Part 5: station tabs

- `src/lib/styles/tabs.css` (unlayered, after station.css) frames Files, Terminal, Changes, Cleanup, Activity, Configuration and the posture banner per vibe on `.ap-fb*`, `.ap-ftree*`, `.ap-ftabs`, `.ap-pbar`, `.ap-mdbar`, `.ap-term*`, `.ap-panel`, `.ap-list`, `.ap-frow`, `.ap-diff-box`, `.ap-cfg*`, `.ap-posture`. Daylight raised cards; Paper, Studio, Quiet ruled frames on the ground; Studio's Rendered/Source switch is ink-filled.
- The file tree is a WAI-ARIA tree (`tree`/`treeitem`/`group`, `aria-level`, `aria-expanded`, `aria-selected`, one tab stop, arrows, Home/End, Right/Left). Rename/delete (and the preview tab close) are always visible and 44px on a coarse pointer (defect fix).
- One diff style: `DiffLines` gained a `patch` form (unified diff); ChangesetPanel uses it instead of a Shiki `diff` code block. No other diff renderer remains.
- xterm and Monaco repaint through the Part 1 `onAppearanceChange` (already pinned by tests).
- Wrap or build: Dialog, Disclosure, Notice, Loading, EmptyState (vibekit) not used here: TypeToConfirmDialog/ConfirmDialog copy and roles, the `Empty` placeholders and the skeletons are pinned by tests; restyled instead.

## Part 6: admin, dialogs, palette

- `src/lib/styles/admin.css` (unlayered, after tabs.css): the guard states (`.ap-guard`), the admin section strip (`.ap-atabs`: Daylight pills, Paper italic underlined, Studio ruled strip, Quiet plain links), the account-plane notice (`.ap-notice`), AdminStats as a `dl` (`.ap-stats`, Banned red only when non-zero), the grants enforcement banner (`.ap-banner[data-tone]`), bridge rows and form (`.ap-brow`, `.ap-adm-form`, `.ap-in` for its plain fields), and the command palette (`.ap-pal`, also on file quick-open): uppercase group heads, a 3px accent bar on the selected row, 56px input.
- The command primitives lost their `!important` utilities (`rounded-xl!`, `h-8!` ...): a layered important beats any unlayered rule, so the vibe styles could not reach them.
- Defect fixes: the admin guard calls `getAdminStats()` itself and only a 403 is "Access denied"; a network failure or a 500 shows the error's own message with Retry (`checkIsAdmin`, which swallowed every failure, is removed). Under the plane Users shows only the notice (no stats, signup switch, Create user, filters); Grants already did and is now pinned; users/[id] shows the notice instead of a raw error with Retry. users/[id] no longer nests an `h-screen` main inside the shell.
- Wrap or build: Dialog (vibekit `consequences`, sizes), CommandPalette, Notice, Menu not used, for the Part 1 reasons (composed bits-ui dialogs pinned by role and copy; vibekit's destructive confirm is an `alertdialog`; the palette's groups, `value` matching and keyboard behaviour are pinned by tests and bits-ui Command already provides them). Restyled instead.
- Harness: `e2e/shots.mjs --admin=legacy|plane|denied|offline|500`, `--keys=Control+k`, `--click="sel|sel"`, `--name=`; admin stubs for users, stats, signup, bridge roster, speech and transcription settings.

## Part 8: sweep

- `e2e/sweep.mjs` (`pnpm e2e:sweep`, not part of `pnpm test`) runs axe-core (wcag2a, wcag2aa), a horizontal-scroll check, a console-error check and a 44px target check under 1024px over every page and key state, against the stubbed hub in `e2e/harness.mjs` (shared with `e2e/shots.mjs`). It takes no screenshots.
- Touch floor: `app.css` has a zero-specificity base rule (controls, standalone links, labels wrapping a radio or checkbox at 44px under 1024px and on a coarse pointer) and an unlayered block after the imported sheets for the product's own sized controls (`.ap-ftool`, `.ap-pbar`, `.ap-term-tool`, `.ap-st-tabs`, `.ap-modes`, `.ap-mdbar`, `.ap-group-row`, `.ap-ftree-row`, `.ap-ftab`, Studio's cue and filter). A new desktop min-height in a page sheet needs a line there.
- Files: each open file is a `.ap-ftab` wrapper holding the `role=tab` and its real "Close <name>" button as siblings (no button inside a tab, axe nested-interactive; selected styling keys on `.ap-ftab:has(> [aria-selected="true"])`). Delete or Backspace closes the focused tab, middle-click closes, focus then moves to the next tab, the previous, or the tree; the strip is a roving tabindex with Left/Right/Home/End. The rendered Markdown preview is a focusable region.
- Studio's header Stop is ink, not danger red (the mockup); the confirm dialog still says what it does.
- Excluded, recorded: bits-ui Command (the palette) renders its combobox input without `aria-controls` and its listbox as an unfocusable scroll region; the sweep drops exactly those two rule/selector pairs (`KNOWN` in sweep.mjs).
