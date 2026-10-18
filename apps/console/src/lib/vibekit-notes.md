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
