/**
 * The face an agent gets when nobody gave it one.
 *
 * `pickAvatar` looks for a picture the agent's own workspace carries. Most
 * stations on a coding harness have none — `avatar.png` in a project repo is a
 * file you would have to commit — so they render as a letter, and a machine
 * running a dozen of them is a column of letters that says nothing about what
 * is running where.
 *
 * The mark answers *what*: the harness's own logo, in white. The ground colour
 * answers *which*: derived from the station key, so the eight opencode stations
 * on one laptop are eight different circles rather than eight identical ones.
 * The display name already carries the harness (`supermessage (claude-code @
 * host)`), so spending the whole avatar on the logo would restate what you can
 * read and lose the part you cannot.
 *
 * Composited here rather than shipped pre-rendered because the ground is
 * per-station and unbounded. It is a fill and an alpha blend over 65k pixels —
 * done once per faceless station per boot, behind the same `hasFace` gate that
 * stops the workspace read from repeating.
 */

import { PNG } from "pngjs";
import { readFile } from "node:fs/promises";

/**
 * Harnesses we hold a mark for.
 *
 * Not a judgement about which harnesses deserve a face — just which files
 * exist. hermes and openclaw agents overwhelmingly carry their own picture, and
 * one that does not stays a letter rather than wearing its runtime's logo,
 * which for a named agent would be a downgrade.
 *
 * It doubles as the guard on the file path: `harness` arrives from a database
 * column, and resolving that against the asset directory unchecked is how a row
 * becomes a read somewhere else on the disk.
 */
export const MARKED_HARNESSES = ["claude-code", "codex", "opencode", "pi"] as const;

export type MarkedHarness = (typeof MARKED_HARNESSES)[number];

/**
 * Grounds the mark can sit on.
 *
 * A curated list rather than a hue computed from the hash: the mark is white,
 * and free-running HSL wanders into colours that swallow it. Every entry here
 * clears 4.5:1 against white, which the tests assert so a future addition
 * cannot quietly break it.
 *
 * Sixteen, which is a ceiling rather than a target. Collisions are expected —
 * one machine here runs fourteen claude-code stations, and sixteen buckets will
 * hand two of them the same colour. Adding a fiftieth colour would not fix
 * that: past this many, entries stop being distinguishable at avatar size, and
 * two circles that are almost-but-not-quite the same green read worse than two
 * that are frankly identical. The name is beside the avatar; the colour is a
 * second cue, not an identifier.
 */
export const MARK_PALETTE = [
  "#B4472E",
  "#C2410C",
  "#A16207",
  "#3F6212",
  "#15803D",
  "#0F766E",
  "#0369A1",
  "#1D4ED8",
  "#6D28D9",
  "#A21CAF",
  "#BE185D",
  "#9F1239",
  "#7C2D12",
  "#065F46",
  "#075985",
  "#6B21A8",
] as const;

/** 256px is the size Matrix clients thumbnail an avatar down from. */
const CANVAS = 256;

function isMarked(harness: string): harness is MarkedHarness {
  return (MARKED_HARNESSES as readonly string[]).includes(harness);
}

/**
 * The ground colour for a station, stable forever.
 *
 * FNV-1a rather than anything cryptographic: this picks one of twelve colours,
 * and the only property that matters is that it never changes. The avatar is
 * uploaded once and then lives in the homeserver, so a colour that moved
 * between restarts would be a different face every deploy.
 */
export function markColour(stationKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < stationKey.length; i++) {
    hash ^= stationKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return MARK_PALETTE[hash % MARK_PALETTE.length]!;
}

/** Cache of the decoded source marks — three small images, read once. */
const marks = new Map<MarkedHarness, PNG>();

async function loadMark(harness: MarkedHarness): Promise<PNG> {
  const cached = marks.get(harness);
  if (cached) return cached;
  // Resolved from this module rather than from cwd: the hub is started by
  // systemd from a unit file whose working directory is not something this code
  // should be guessing at.
  const path = new URL(
    `../../../assets/harness-marks/${harness}.png`,
    import.meta.url
  );
  const png = PNG.sync.read(await readFile(path));
  marks.set(harness, png);
  return png;
}

/**
 * The generated avatar for a station, or null when we have no mark for its
 * harness — which is not an error, just a station that stays a letter.
 */
export async function harnessMark(
  harness: string,
  stationKey: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!isMarked(harness)) return null;

  let mark: PNG;
  try {
    mark = await loadMark(harness);
  } catch {
    // A missing or corrupt asset must not fail provisioning, for the same
    // reason an unreachable workspace does not: an avatar is decoration.
    return null;
  }

  const hex = markColour(stationKey);
  const bg = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ] as const;

  const out = new PNG({ width: CANVAS, height: CANVAS });
  for (let i = 0; i < out.data.length; i += 4) {
    // `a` is the mark's coverage at this pixel; the source is white, so the
    // blend collapses to "lift each channel towards 255 by the coverage".
    const a = mark.data[i + 3]! / 255;
    out.data[i] = Math.round(bg[0] + (255 - bg[0]) * a);
    out.data[i + 1] = Math.round(bg[1] + (255 - bg[1]) * a);
    out.data[i + 2] = Math.round(bg[2] + (255 - bg[2]) * a);
    // Opaque throughout. A transparent avatar would be composited over
    // whatever the client's own background is, and a white mark on a white
    // background is an empty circle.
    out.data[i + 3] = 255;
  }

  return {
    bytes: new Uint8Array(PNG.sync.write(out)),
    contentType: "image/png",
  };
}
