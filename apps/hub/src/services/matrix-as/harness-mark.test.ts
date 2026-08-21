import { describe, expect, test } from "bun:test";
import {
  MARK_PALETTE,
  MARKED_HARNESSES,
  harnessMark,
  markColour,
} from "./harness-mark";

/**
 * The face an agent gets when it has not been given one.
 *
 * A workspace `avatar.png` is per-agent; a harness mark is per-harness, so on a
 * machine running eight opencode stations the mark alone would make eight
 * identical circles. The ground colour is what keeps them apart, and it is
 * derived from the station key so it is the same on every device and after
 * every restart.
 */

describe("the harness mark", () => {
  test("is offered only for harnesses we actually have a mark for", async () => {
    // Not a policy about which harnesses deserve faces — just whether a file
    // exists. hermes and openclaw agents mostly carry their own picture, and
    // one that does not stays a letter rather than borrowing someone's logo.
    expect(MARKED_HARNESSES).toContain("claude-code");
    expect(MARKED_HARNESSES).toContain("codex");
    expect(MARKED_HARNESSES).toContain("opencode");
    expect(await harnessMark("hermes", "hermes:coder-kai")).toBeNull();
  });

  test("refuses a harness name that is not one of ours", async () => {
    // `harness` comes out of the database and becomes part of a file path.
    // Resolving it against the asset directory without checking it first is how
    // a row turns into a file read somewhere else entirely.
    expect(await harnessMark("../../../../etc/passwd", "k")).toBeNull();
    expect(await harnessMark("", "k")).toBeNull();
  });

  test("gives the same station the same colour every time", () => {
    // The avatar is uploaded once and then lives in the homeserver. A colour
    // that moved between restarts would be a different face each deploy.
    const once = markColour("opencode:18be38ff");
    const again = markColour("opencode:18be38ff");
    expect(once).toBe(again);
  });

  test("separates the stations that would otherwise look alike", () => {
    // The eight opencode stations on one laptop are the case this exists for.
    const keys = [
      "opencode:7bfd248e",
      "opencode:18be38ff",
      "opencode:6801f54b",
      "opencode:37aa52a1",
      "opencode:a8b199ad",
      "opencode:c2c9f8e2",
      "opencode:bf9947fa",
      "opencode:44cb06df",
    ];
    const colours = new Set(keys.map(markColour));
    // Not all-distinct — a hash into a fixed palette collides, and pretending
    // otherwise would be a test that fails on an unlucky key rather than on a
    // real regression. Most of them being different is the whole benefit.
    expect(colours.size).toBeGreaterThanOrEqual(keys.length - 2);
  });

  test("keeps the white mark legible on every colour it can choose", () => {
    // The mark is white. A palette entry light enough to swallow it would make
    // an avatar that reads as an empty coloured circle, and nothing in the
    // hashing would tell us which stations drew it.
    for (const colour of MARK_PALETTE) {
      expect(contrastWithWhite(colour)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("draws a real PNG, the mark's ground filled in", async () => {
    const found = await harnessMark("claude-code", "claude-code:c2c9f8e2");
    expect(found).not.toBeNull();
    expect(found!.contentType).toBe("image/png");

    // PNG signature — the bytes have to be an image, not a rendering promise.
    expect(Array.from(found!.bytes.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    // Fully opaque: the source mark is white-on-transparent, and a Matrix
    // client that composites an avatar over its own background would otherwise
    // show a white shape on white.
    //
    // Counted, not asserted per pixel. A loop of 65k `expect`s reports the
    // first bad pixel as "expected 255, got 0" with no idea how many others
    // there were, and costs real time in a suite that shares one process with
    // every other hub test.
    const { PNG } = await import("pngjs");
    const png = PNG.sync.read(Buffer.from(found!.bytes));
    expect(png.width).toBe(256);
    expect(png.height).toBe(256);

    let translucent = 0;
    let ink = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i + 3] !== 255) translucent++;
      // The mark is white; the ground is not. Anything at full white is ink.
      if (png.data[i] === 255 && png.data[i + 1] === 255 && png.data[i + 2] === 255) ink++;
    }
    expect(translucent).toBe(0);
    // The mark is actually drawn — a bug that filled the ground and skipped the
    // blend would still be a valid, fully opaque PNG of a plain coloured square.
    expect(ink).toBeGreaterThan(1000);
  });

  test("gives two stations of one harness different images", async () => {
    // Same mark, different ground. If these came back byte-identical the
    // colour derivation is not reaching the pixels.
    const a = await harnessMark("opencode", "opencode:18be38ff");
    const b = await harnessMark("opencode", "opencode:6801f54b");
    expect(Buffer.from(a!.bytes).equals(Buffer.from(b!.bytes))).toBe(false);
  });

  test("gives the same station the same bytes twice", async () => {
    // Provisioning runs on every boot. Re-uploading a byte-different image for
    // an unchanged station would churn the media repo for nothing.
    const a = await harnessMark("codex", "codex:4a1482de");
    const b = await harnessMark("codex", "codex:4a1482de");
    expect(Buffer.from(a!.bytes).equals(Buffer.from(b!.bytes))).toBe(true);
  });
});

/** WCAG contrast ratio of `#rrggbb` against white. */
function contrastWithWhite(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05);
}
