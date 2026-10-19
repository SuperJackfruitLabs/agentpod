#!/usr/bin/env node
/**
 * Screenshots of the built console (static SPA in build/) against a stubbed hub, for comparing
 * by eye with the approved mockups. No real hub, no sign-in: every request to the hub is answered
 * here with the canonical sample fleet, and everything else off this machine is refused.
 *
 *   PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build
 *   node e2e/shots.mjs [--path=/] [--vibes=daylight,paper,studio,quiet] [--themes=light,dark]
 *                      [--sizes=desktop,tablet,phone,phone360] [--jpeg] [--menu] [--more] [--state=populated|loading|error|empty]
 *                      [--signedout] [--out=e2e/shots]
 *                      [--tab=chat|health|logs|files|terminal|changes|cleanup|activity|config] [--about]
 *                      [--chat=live|none|ended] [--health=running|stopped|error]
 *                      [--open=IDENTITY.md] [--changes=dirty|clean|error] [--scan] [--activity=rows|empty|error]
 *
 * Admin: --admin=legacy|plane|denied|offline|500 (default legacy) answers the admin reads as a hub
 * without the account plane (users, signup, grants listed), under the plane (410
 * managed_by_org_plane for users and grants), or the guard's check as a 403, a network failure or
 * a 500. Dialogs: --keys=Control+k presses keys after load (the palette), --click="a|b" clicks
 * each selector in turn (opening a dialog), --name=x adds "-x" to the file name.
 *
 * The station tabs: --open opens a file in Files (the tree click), --changes picks the workspace
 * the Changes tab reads (dirty also opens README.md's patch), --scan presses Cleanup's Scan,
 * --activity what the station's audit read returns. Terminal replays a short fake PTY stream.
 *
 * --menu opens the account menu with Appearance expanded (desktop); --more opens the phone's More
 * sheet. --state answers the fleet's reads as populated (default), never (loading), 500 (error)
 * or with nothing enrolled (empty). --signedout answers get-session with no session, so the
 * console shows its sign-in page (the hub without an account plane). --path=/nope shows the 404. Uses playwright-core with an already installed Chromium (its own revision in the
 * Playwright cache, or PLAYWRIGHT_CHROMIUM); it never downloads a browser. Output is git-ignored.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { NOON, chromiumPath, serve, stubPage } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.length ? rest.join("=") : true];
  }),
);
const list = (v, d) => (typeof v === "string" ? v.split(",") : d);
const VIBES = list(args.vibes, ["daylight", "paper", "studio", "quiet"]);
const THEMES = list(args.themes, ["light", "dark"]);
const SIZES = list(args.sizes, ["desktop", "phone"]);
const PATH = typeof args.path === "string" ? args.path : "/";
const STATE = typeof args.state === "string" ? args.state : "populated";
const SIGNED_OUT = !!args.signedout;
// The station page (--path=/nodes/n_ashram/stations/st_annapurna): --tab picks the tab, --about opens
// the phone's About sheet, --chat the session the transcript shows (a live one waiting on a permission,
// none at all, or an ended one), --health what the station reports. --sizes may include tablet (1024).
const TAB = typeof args.tab === "string" ? args.tab : null;
const CHAT = typeof args.chat === "string" ? args.chat : "live";
const HEALTH = typeof args.health === "string" ? args.health : "running";
const OPEN = typeof args.open === "string" ? args.open : null;
const CHANGES = typeof args.changes === "string" ? args.changes : "dirty";
const ACTIVITY_STATE = typeof args.activity === "string" ? args.activity : "rows";
const ADMIN = typeof args.admin === "string" ? args.admin : "legacy";
const KEYS = typeof args.keys === "string" ? args.keys.split(",") : [];
const CLICKS = typeof args.click === "string" ? args.click.split("|") : [];
const NAME = typeof args.name === "string" ? args.name : null;
/** --jpeg writes a smaller JPEG instead of a PNG (phone passes, many shots, little disk). */
const JPEG = !!args.jpeg;
const OUT = resolve(typeof args.out === "string" ? args.out : join(here, "shots"));
const VIEWPORT = { desktop: { width: 1440, height: 900 }, tablet: { width: 1024, height: 800 }, phone: { width: 390, height: 844 }, phone360: { width: 360, height: 740 } };
// --height=N makes the desktop viewport taller (the stage scrolls inside the shell, so a full-page
// shot would not show more): for comparing a long page with its mockup.
if (typeof args.height === "string") VIEWPORT.desktop.height = Number(args.height);


const { server, origin } = await serve();
const browser = await chromium.launch({ executablePath: chromiumPath() });
await mkdir(OUT, { recursive: true });
const unknown = new Set();
try {
  for (const vibe of VIBES)
    for (const theme of THEMES)
      for (const size of SIZES) {
        const context = await browser.newContext({ viewport: VIEWPORT[size], deviceScaleFactor: 1, colorScheme: theme });
        const strength = vibe === "quiet" ? "off" : "strong";
        await context.addCookies([{ name: "vk_appearance", value: `${vibe}.${theme}.${strength}.0`, url: origin }]);
        const page = await context.newPage();
        // Noon, so Daylight's sky is the mockups' noon sky.
        await page.clock.setFixedTime(NOON);
        await stubPage(page, origin, { state: STATE, signedOut: SIGNED_OUT, chat: CHAT, health: HEALTH, changes: CHANGES, activity: ACTIVITY_STATE, admin: ADMIN }, unknown);
        await page.goto(origin + PATH + (TAB ? `?tab=${TAB}` : ""));
        if (SIGNED_OUT) await page.waitForSelector(".ap-auth__card", { timeout: 15_000 });
        else {
          await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
          if (STATE === "populated") await page.waitForSelector('[data-testid="roster-row"]', { timeout: 15_000 }).catch(() => {});
        }
        let suffix = "";
        if (args.menu && size === "desktop") {
          await page.click('[data-testid="account-chip"]');
          await page.click('[data-testid="account-menu"] button[aria-expanded]');
          suffix = "-menu";
        }
        if (args.more && size === "phone") {
          await page.click('[data-testid="phone-bar"] button');
          await page.waitForSelector('[data-testid="more-sheet"]');
          suffix = "-more";
        }
        if (args.about && size === "phone") {
          await page.click(".ap-st-about");
          await page.waitForSelector('[data-testid="station-about"]');
          suffix += "-about";
        }
        if (TAB === "files" && OPEN) {
          await page.click(`[role="treeitem"][data-tree-path="${OPEN}"] .ap-ftree-row`);
          await page.waitForSelector(".ap-pbar");
          suffix += `-${OPEN.replace(/\W+/g, "_")}`;
        }
        if (TAB === "changes" && CHANGES === "dirty") {
          await page.click('[data-testid="changeset-file-README.md"]').catch(() => {});
          await page.waitForSelector("[data-diff]").catch(() => {});
        }
        if (TAB === "changes" && CHANGES !== "dirty") suffix += `-${CHANGES}`;
        if (TAB === "cleanup" && args.scan) {
          await page.click('.ap-panel button:has-text("Scan")');
          await page.waitForSelector('.ap-list');
          await page.click('.ap-list input[type="checkbox"]');
          suffix += "-scan";
        }
        if (TAB === "activity" && ACTIVITY_STATE !== "rows") suffix += `-${ACTIVITY_STATE}`;
        if (TAB) suffix += `-${TAB}`;
        if (CHAT !== "live") suffix += `-chat${CHAT}`;
        if (HEALTH !== "running") suffix += `-health${HEALTH}`;
        await page.waitForTimeout(400);
        for (const key of KEYS) await page.keyboard.press(key);
        for (const sel of CLICKS) {
          await page.click(sel);
          await page.waitForTimeout(250);
        }
        if (KEYS.length || CLICKS.length) await page.waitForTimeout(300);
        if (ADMIN !== "legacy") suffix += `-admin${ADMIN}`;
        if (NAME) suffix += `-${NAME}`;
        if (STATE !== "populated") suffix += `-${STATE}`;
        if (SIGNED_OUT) suffix += "-signedout";
        const name = `${PATH === "/" ? "fleet" : PATH.replace(/\W+/g, "_").replace(/^_|_$/g, "")}-${vibe}-${theme}-${size}${suffix}.png`;
        // No horizontal page scroll: report the document's overflow and the elements past the edge.
        const over = await page.evaluate(() => {
          const w = document.documentElement.clientWidth;
          const sw = document.documentElement.scrollWidth;
          if (sw <= w) return null;
          const past = [...document.querySelectorAll("body *")]
            .filter((el) => el.getBoundingClientRect().right > w + 1 && el.getClientRects().length)
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
          return { sw, w, past };
        });
        if (over) console.log(`OVERFLOW ${name}: ${over.sw} > ${over.w} ${over.past.join(" | ")}`);
        const file = JPEG ? name.replace(/\.png$/, ".jpg") : name;
        await page.screenshot({ path: join(OUT, file), ...(JPEG ? { type: "jpeg", quality: 60 } : {}) });
        console.log(join(OUT, file));
        await context.close();
      }
} finally {
  await browser.close();
  server.close();
}
if (unknown.size) console.log(`Not stubbed (answered 404): ${[...unknown].join(", ")}`);
