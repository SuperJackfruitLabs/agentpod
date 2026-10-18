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
