/**
 * One Shiki treatment for every code surface (code blocks, the markdown preview, chat
 * replies): a css-variables theme whose `--shiki-*` colours come from the vibe. The
 * variables have token defaults in app.css (resolved per `[data-vibe][data-theme]`, so
 * light and dark switch with `data-theme`, never a `.dark` class) and are refined to
 * contrast-checked hex by `applyShikiVars()` on every appearance change. Highlighted
 * HTML never needs re-rendering when the vibe or theme changes.
 */
import { createCssVariablesTheme } from "shiki";

export const VIBE_SHIKI_THEME = "agentpod-vibe";

export const vibeShikiTheme = createCssVariablesTheme({
  name: VIBE_SHIKI_THEME,
  variablePrefix: "--shiki-",
  fontStyle: true,
});
