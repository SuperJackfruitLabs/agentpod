# Harness marks

The logo a station wears when nobody gave it a picture of its own.

`pickAvatar` looks for `avatar.png` / `pfp.png` / `.agentpod/avatar.png` in the
station's workspace first; these are the fallback, and only for the harnesses
listed in `MARKED_HARNESSES`. A harness with no file here is not broken — its
stations stay letter avatars, which is the right answer for hermes and openclaw
agents, who have names of their own and mostly carry their own faces.

## What is in here

| File | Harness | Mark |
| --- | --- | --- |
| `claude-code.svg` | `claude-code` | Claude |
| `codex.svg` | `codex` | OpenAI |
| `opencode.svg` | `opencode` | OpenCode |
| `pi.svg` | `pi` | pi |

The `.svg` files are the **sources**, kept byte-identical to what upstream
publishes so re-fetching one is a clean diff. The white fill the renderer needs
is applied by the build script, not baked into the source.

- `claude-code`, `codex` and `opencode` come from
  [simple-icons](https://github.com/simple-icons/simple-icons) (CC0-1.0 for the
  collection).
- `pi` comes from the project's own site, `https://pi.dev/logo.svg`, which its
  [README](https://github.com/earendil-works/pi) links as the logo. **Not**
  simple-icons' `pi`, which is Pi Network — a cryptocurrency unrelated to
  `@earendil-works/pi-coding-agent`, and using it here would have put the wrong
  company's mark on an agent.

Each mark remains the trademark of its owner and is used here only to identify
the tool that is running.

The `.png` files are **generated** and checked in. They are white-on-transparent
at 256×256, which is the size Matrix clients thumbnail an avatar down from.

## Why the PNGs are committed

The hub composites the mark over a per-station colour at provisioning time. It
must not shell out to a rasteriser to do it — `rsvg-convert` is not on a Fly
machine and has no business being a runtime dependency of the bridge. And a
mark that changed silently between two deploys would change every agent's face
with no diff to show for it.

## Rebuilding

Needs `librsvg` and `imagemagick` (`brew install librsvg imagemagick`):

```
./build-marks.sh
```

Re-run it after replacing a source SVG, and commit both files together.
