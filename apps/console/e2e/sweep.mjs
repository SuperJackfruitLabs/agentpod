#!/usr/bin/env node
/**
 * Accessibility and overflow sweep of the built console against the stubbed hub (e2e/harness.mjs).
 * For every visit (a page or state, a vibe, a theme, a width) it asserts: no axe-core violations
 * (wcag2a, wcag2aa), no horizontal page scroll, no console error or page error, no hub request the
 * harness does not know, and, under 1024px, every visible interactive target at least 44px square
 * (inline links in running text excepted). It takes no screenshots.
 *
 *   PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build
 *   pnpm e2e:sweep [--vibes=daylight] [--themes=light,dark] [--widths=360,390,1024,1440] [--only=fleet,agents]
 *                  [--detail] (each violation's first element and why) [--verbose] (print passing visits too)
 *
 * Daylight sweeps every page and key state; Paper, Studio and Quiet sweep one representative state per
 * page type (the `rep` ones) at 360, 390 and 1440. Exits 1 when any visit fails. Not part of `pnpm test`.
 * Uses playwright-core with an already installed Chromium; it never downloads a browser.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { NOON, chromiumPath, serve, stubPage } from "./harness.mjs";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.length ? rest.join("=") : true];
  }),
);
const list = (v, d) => (typeof v === "string" ? v.split(",") : d);
const VIBES = list(args.vibes, ["daylight", "paper", "studio", "quiet"]);
const THEMES = list(args.themes, ["light", "dark"]);
const ONLY = list(args.only, null);

const ST = "/nodes/n_ashram/stations/st_annapurna";
const shell = '[data-testid="app-shell"]';
const rows = '[data-testid="roster-row"]';
/** Every visit: a name, a path, the harness options, what to wait for, and what to do after load. */
const VISITS = [
  { name: "fleet", path: "/", wait: rows, rep: true },
  { name: "fleet-loading", path: "/", o: { state: "loading" } },
  { name: "fleet-error", path: "/", o: { state: "error" } },
  { name: "fleet-empty", path: "/", o: { state: "empty" } },
  { name: "agents", path: "/agents", wait: rows, rep: true },
  { name: "nodes", path: "/nodes", rep: true },
  { name: "node", path: "/nodes/n_ashram", rep: true },
  { name: "runtimes", path: "/runtimes", rep: true },
  { name: "dialog", path: "/runtimes", rep: true, act: async (p) => { await p.click('[data-testid="new-runtime-btn"]'); await p.waitForSelector('[role="dialog"]'); } },
  { name: "activity", path: "/activity", rep: true },
  { name: "settings", path: "/settings", rep: true },
  { name: "chat-permission", path: ST, rep: true },
  { name: "chat-none", path: ST, o: { chat: "none" } },
  { name: "chat-ended", path: ST, o: { chat: "ended" } },
  { name: "health", path: ST, tab: "health" },
  { name: "health-stopped", path: ST, tab: "health", o: { health: "stopped" } },
  { name: "health-error", path: ST, tab: "health", o: { health: "error" } },
  { name: "logs", path: ST, tab: "logs" },
  { name: "files", path: ST, tab: "files", rep: true },
  { name: "files-open", path: ST, tab: "files", act: async (p) => { await p.click('[role="treeitem"][data-tree-path="IDENTITY.md"] .ap-ftree-row'); await p.waitForSelector(".ap-pbar"); } },
  { name: "terminal", path: ST, tab: "terminal", rep: true },
  { name: "changes", path: ST, tab: "changes", rep: true, act: async (p) => { await p.click('[data-testid="changeset-file-README.md"]'); await p.waitForSelector("[data-diff]"); } },
  { name: "changes-clean", path: ST, tab: "changes", o: { changes: "clean" } },
  { name: "changes-error", path: ST, tab: "changes", o: { changes: "error" } },
  { name: "cleanup", path: ST, tab: "cleanup" },
  { name: "cleanup-scan", path: ST, tab: "cleanup", act: async (p) => { await p.click('.ap-panel button:has-text("Scan")'); await p.waitForSelector(".ap-list"); await p.click('.ap-list input[type="checkbox"]'); } },
  { name: "st-activity", path: ST, tab: "activity" },
  { name: "st-activity-empty", path: ST, tab: "activity", o: { activity: "empty" } },
  { name: "st-activity-error", path: ST, tab: "activity", o: { activity: "error" } },
  { name: "config", path: ST, tab: "config", rep: true },
  { name: "about-sheet", path: ST, phone: true, act: async (p) => { await p.click(".ap-st-about"); await p.waitForSelector('[data-testid="station-about"]'); } },
  { name: "admin-users", path: "/admin/users" },
  { name: "admin-users-plane", path: "/admin/users", o: { admin: "plane" }, rep: true },
  { name: "admin-user", path: "/admin/users/u_one" },
  { name: "admin-denied", path: "/admin/users", o: { admin: "denied" } },
  { name: "admin-500", path: "/admin/users", o: { admin: "500" } },
  { name: "admin-bridge", path: "/admin/bridge", rep: true },
  { name: "admin-grants", path: "/admin/grants" },
  { name: "admin-speech", path: "/admin/speech" },
  { name: "admin-transcription", path: "/admin/transcription" },
  { name: "palette", path: "/", wait: rows, rep: true, act: async (p) => { await p.keyboard.press("Control+k"); await p.waitForSelector('[role="dialog"]'); } },
  { name: "account-menu", path: "/", wait: rows, desktop: true, act: async (p) => { await p.click('[data-testid="account-chip"]'); await p.click('[data-testid="account-menu"] button[aria-expanded]'); } },
  { name: "more-sheet", path: "/", phone: true, act: async (p) => { await p.click('[data-testid="phone-bar"] button'); await p.waitForSelector('[data-testid="more-sheet"]'); } },
  { name: "404", path: "/nope", rep: true, allow: /^\w+: Not found: \/nope/ }, // SvelteKit logs the 404 it renders
  { name: "sign-in", path: "/", o: { signedOut: true }, wait: ".ap-auth__card", rep: true },
];
/**
 * Violations inside a third-party widget, recorded and excluded by rule and selector only:
 * bits-ui's Command (the palette) renders its combobox input without aria-controls and its
 * listbox as a scroll region that takes no focus (focus stays in the input, aria-activedescendant).
 */
const KNOWN = [
  { rule: "aria-required-attr", sel: '[data-slot="command-input"]' },
  { rule: "scrollable-region-focusable", sel: '[data-slot="command-list"]' },
];
const HEIGHT = { 360: 740, 390: 844, 1024: 800, 1440: 900 };

/** In the page: interactive targets under 44px (inline links in running text, hidden and widget internals excepted). */
function smallTargets() {
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], [role="treeitem"] > *:first-child';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('.xterm, .monaco-editor, [aria-hidden="true"], [inert], .sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    let r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue; // visually hidden (sr-only inputs behind a label)
    // A control inside a label (or labelled by one) is hit through the label.
    const label = el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    const lr = label && el.matches("input") ? label.getBoundingClientRect() : null;
    const ok = (x) => x.width >= 43.5 && x.height >= 43.5;
    if (ok(r) || (lr && ok(lr))) continue;
    if (el.matches("a") && cs.display === "inline") {
      const block = el.parentElement;
      const text = block ? block.textContent.replace(el.textContent, "").trim() : "";
      if (text.length > 0) continue; // inline link in running text
    }
    const id = el.getAttribute("data-testid") || el.getAttribute("aria-label") || el.textContent.trim().slice(0, 30);
    out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")} "${id}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out;
}

const plan = [];
for (const vibe of VIBES) {
  const daylight = vibe === "daylight";
  const widths = list(args.widths, daylight ? [360, 390, 1024, 1440] : [360, 390, 1440]).map(Number);
  for (const v of VISITS) {
    if (!daylight && !v.rep) continue;
    if (ONLY && !ONLY.includes(v.name)) continue;
    for (const theme of THEMES)
      for (const width of widths) {
        if (v.phone && width > 900) continue;
        if (v.desktop && width <= 900) continue;
        plan.push({ v, vibe, theme, width });
      }
  }
}

const { server, origin } = await serve();
const browser = await chromium.launch({ executablePath: chromiumPath() });
const failures = [];
const tally = {};
try {
  for (const { v, vibe, theme, width } of plan) {
    const key = `${vibe}/${theme}/${width}`;
    tally[key] = (tally[key] ?? 0) + 1;
    const id = `${v.name} ${key}`;
    const problems = [];
    const context = await browser.newContext({ viewport: { width, height: HEIGHT[width] }, deviceScaleFactor: 1, colorScheme: theme });
    await context.addCookies([{ name: "vk_appearance", value: `${vibe}.${theme}.${vibe === "quiet" ? "off" : "strong"}.0`, url: origin }]);
    const page = await context.newPage();
    page.on("console", (m) => {
      // A stubbed error state answers 4xx/5xx on purpose; the browser's resource line is not the app's error.
      if (m.type() === "error" && !/^Failed to load resource/.test(m.text()) && !(v.allow && v.allow.test(m.text()))) problems.push(`console: ${m.text().slice(0, 200)}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${String(e.message).slice(0, 200)}`));
    await page.clock.setFixedTime(NOON);
    const unknown = new Set();
    await stubPage(page, origin, v.o ?? {}, unknown);
    try {
      await page.goto(origin + v.path + (v.tab ? `?tab=${v.tab}` : ""));
      await page.waitForSelector(v.wait === ".ap-auth__card" ? v.wait : shell, { timeout: 15_000 });
      if (v.wait === rows) await page.waitForSelector(rows, { timeout: 5_000 }).catch(() => {}); // rows are cards on a phone
      await page.waitForTimeout(500);
      if (v.act) {
        await v.act(page);
        await page.waitForTimeout(400);
      }
      await page.addScriptTag({ content: AXE });
      const axe = await page.evaluate(async ([detail, known]) => {
        const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        for (const x of r.violations)
          x.nodes = x.nodes.filter((n) => !known.some((k) => k.rule === x.id && document.querySelector(n.target[0])?.matches(k.sel)));
        return r.violations.filter((x) => x.nodes.length).map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" , ")}${x.nodes.length > 4 ? ` +${x.nodes.length - 4}` : ""}${detail ? `\n      ${x.nodes[0].html.slice(0, 240)}\n      ${x.nodes[0].failureSummary.replace(/\n/g, " ").slice(0, 300)}` : ""}`);
      }, [!!args.detail, KNOWN]);
      for (const a of axe) problems.push(`axe ${a}`);
      const over = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const sw = document.documentElement.scrollWidth;
        if (sw <= w) return null;
        const past = [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > w + 1 && el.getClientRects().length)
          .slice(0, 4)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`);
        return `${sw} > ${w}: ${past.join(" | ")}`;
      });
      if (over) problems.push(`overflow ${over}`);
      if (width < 1024) for (const t of await page.evaluate(smallTargets)) problems.push(`target ${t}`);
    } catch (e) {
      problems.push(`visit: ${String(e.message).split("\n")[0]}`);
    }
    for (const u of unknown) problems.push(`not stubbed: ${u}`);
    await context.close();
    if (problems.length) {
      failures.push(id);
      console.log(`FAIL ${id}\n  ${problems.join("\n  ")}`);
    } else if (args.verbose) console.log(`ok   ${id}`);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${plan.length} visits, ${failures.length} failed`);
for (const [k, n] of Object.entries(tally)) console.log(`  ${k}: ${n}`);
process.exit(failures.length ? 1 : 0);
