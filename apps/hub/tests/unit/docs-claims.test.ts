/**
 * The published documentation is checked against the code it describes.
 *
 * `docs/README.md` names the failure mode this exists to prevent: "a description far from its
 * code with no check". Everything the 2026-08-14 audit found wrong had exactly that shape, and
 * publishing doubles the surface — the pages under `docs-site/` are the ones strangers read,
 * and nobody who reads them can check them against the source.
 *
 * `apps/landing` is the warning recorded in its own README: both of its two outbound links were
 * 404s, because they were ordinary links with no test behind them.
 *
 * So: every tool, command, capability and endpoint these pages name must exist. When this test
 * fails, the page is usually the thing that is wrong — but not always, and that is the point.
 * A name that vanished from the code is either a docs bug or a regression, and this cannot tell
 * you which. It can only tell you they disagree.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../../..");
const SITE = join(REPO, "docs-site/src/content/docs");

interface Page {
  file: string;
  text: string;
}

function pages(dir = SITE, prefix = ""): Page[] {
  const out: Page[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...pages(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx"))
      out.push({ file: rel, text: readFileSync(join(dir, entry.name), "utf8") });
  }
  return out;
}

const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const all = () => pages();

describe("published docs", () => {
  test("there are pages to check", () => {
    // Guards the vacuous pass: every assertion below iterates over this list, so an empty or
    // moved directory would turn the whole file green while checking nothing.
    expect(all().length).toBeGreaterThan(5);
  });

  test("every page has a title and a description", () => {
    for (const page of all()) {
      expect(page.text).toStartWith("---");
      const front = page.text.slice(3, page.text.indexOf("\n---", 3));
      expect(front, `${page.file} frontmatter title`).toInclude("title:");
      expect(front, `${page.file} frontmatter description`).toInclude("description:");
    }
  });

  test("every MCP tool named is registered on the server", () => {
    const registered = new Set(
      [...read("apps/hub/src/mcp/tools.ts").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map(
        (m) => m[1]!,
      ),
    );
    expect(registered.size).toBeGreaterThan(0);

    for (const page of all()) {
      for (const [, name] of page.text.matchAll(/`(agentpod_[a-z_]+)`/g)) {
        expect(registered, `${page.file} names MCP tool ${name}`).toContain(name);
      }
    }
  });

  test("every apn command named is a registered command", () => {
    // Read from what actually DISPATCHES, not from the help table. A command listed in help
    // but not dispatched is the bug in the other direction, and `apn fleet login` — dispatched
    // for months while missing from help — is why this test trusts the switch over the table.
    const known = new Set(
      [...read("apps/node-agent/cmd/agentpod-node/main.go").matchAll(/^\tcase "([a-z]+)"/gm)].map(
        (m) => m[1]!,
      ),
    );
    known.add("node"); // stripped before the switch, so both spellings reach one dispatch
    for (const [, verb] of read("apps/node-agent/cmd/agentpod-node/fleet.go").matchAll(
      /^\tcase "([a-z]+)":/gm,
    )) {
      known.add(verb!);
    }
    expect(known.size).toBeGreaterThan(10);

    for (const page of all()) {
      for (const [, cmd] of page.text.matchAll(/`apn (?:fleet )?([a-z]+)/g)) {
        expect(known, `${page.file} names \`apn ${cmd}\``).toContain(cmd);
      }
    }
  });

  test("every capability named in a gating table is really gated", () => {
    const gated = new Set(
      // Every route file that gates, found by reading the directory rather than by listing
      // names here — a hand-kept list would go stale exactly when a new gate is added, which is
      // the moment this check matters most. (An earlier version listed four files by hand and
      // missed station-terminal.ts.)
      readdirSync(join(REPO, "apps/hub/src/routes"))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .flatMap((f) => [
          ...read(`apps/hub/src/routes/${f}`).matchAll(/gateCapability\([^)]*"([a-z.]+)"/g),
        ])
        .map((m) => m[1]!),
    );
    expect(gated.size).toBeGreaterThan(3);

    // Only the capability table on the panels page — prose mentions the words in other senses.
    const panels = all().find((p) => p.file === "use/panels.md");
    expect(panels).toBeDefined();
    for (const [, cap] of panels!.text.matchAll(/^\| `([a-z.]+)` \|/gm)) {
      expect(gated, `use/panels.md claims \`${cap}\` is gated`).toContain(cap);
    }
  });

  test("every internal link resolves to a page", () => {
    const slugs = new Set(all().map((p) => p.file.replace(/\.mdx?$/, "").replace(/\/index$/, "")));
    slugs.add("index");

    for (const page of all()) {
      for (const [, href] of page.text.matchAll(/\]\((\/[^)#]*)(?:#[^)]*)?\)/g)) {
        const slug = href!.replace(/^\/|\/$/g, "") || "index";
        expect(slugs, `${page.file} links to ${href}`).toContain(slug);
      }
    }
  });
});
