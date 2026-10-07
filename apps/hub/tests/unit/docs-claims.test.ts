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
    // but not dispatched is the bug in the other direction, and the fleet `login` verb —
    // dispatched for months while missing from help, back when it still lived under `apn` —
    // is why this test trusts the switch over the table.
    const known = new Set(
      [
        ...read("apps/node-agent/cmd/agentpod-node/main.go").matchAll(
          // `[a-z][a-z-]*`, not `[a-z]+`: six apn commands are hyphenated
          // (`openclaw-errors`, `pi-errors`, `hermes-live`, `hermes-skills`,
          // `native-skills`, `plugin-management`) and `[a-z]+` followed by `"`
          // matched none of them, so none was ever in `known`. The prose scan
          // below had the same bound and captured `openclaw` out of
          // `apn openclaw-errors`, so the first page to name one failed against
          // a set that could not contain it.
          /^\tcase "([a-z][a-z-]*)"/gm,
        ),
      ].map((m) => m[1]!),
    );
    known.add("node"); // stripped before the switch, so both spellings reach one dispatch
    expect(known.size).toBeGreaterThan(10);

    for (const page of all()) {
      for (const [, cmd] of page.text.matchAll(/`apn ([a-z][a-z-]*)/g)) {
        expect(known, `${page.file} names \`apn ${cmd}\``).toContain(cmd);
      }
    }
  });

  test("every fleet command named is a registered command", () => {
    // `agentpod-fleet` split out of `agentpod-node` in this branch, and the old `apn`-prefixed
    // spelling was deleted with no shim, so published pages now write these verbs as
    // `fleet <verb>`. Without this pass, `cli.md` documenting seven `fleet` verbs the
    // `apn` test above never looks at would silently drop the published-docs guard for the
    // whole new binary — exactly the "description far from its code with no check" failure
    // mode this file exists to prevent.
    const known = new Set(
      [
        ...read("apps/node-agent/cmd/agentpod-fleet/fleet.go").matchAll(/^\tcase "([a-z][a-z-]*)":/gm),
      ].map((m) => m[1]!),
    );
    // `help` and `version` are dispatched by agentpod-fleet's main.go, one level above
    // fleet.go's switch (see fleet.go's own header comment on the split) — real verbs, just
    // not ones fleet.go's switch can see.
    known.add("help");
    known.add("version");
    expect(known.size).toBeGreaterThan(5);

    for (const page of all()) {
      for (const [, cmd] of page.text.matchAll(/`fleet ([a-z][a-z-]*)/g)) {
        expect(known, `${page.file} names \`fleet ${cmd}\``).toContain(cmd);
      }
    }
  });

  // ─── Subcommands ────────────────────────────────────────────────────────────
  //
  // The test above captures only the FIRST word after `fleet`, so
  // `fleet config opt-out` has always been read as `config` and no subcommand
  // was ever checked. A page could claim `fleet config total-nonsense` and the
  // suite stayed green. There are eleven verbs under `fleet config` alone and
  // several are documented today, so the published pages carried an unchecked
  // surface far larger than the one that was checked.

  const FLEET_CMD_DIR = "apps/node-agent/cmd/agentpod-fleet";

  /** Every non-test Go source in the fleet CLI, as text. */
  const fleetGoSources = () =>
    readdirSync(join(REPO, FLEET_CMD_DIR))
      .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
      .map((f) => read(`${FLEET_CMD_DIR}/${f}`));

  /**
   * The body of a top-level Go func, from its signature to the next one.
   *
   * Function-scoped on purpose. Several of these files hold more than one
   * switch — `skills.go` has six — and reading a whole file would hand
   * `fleet skills` the subcommands of `fleet skills station` as well, turning
   * the check into a superset that cannot tell a real verb from a misplaced
   * one.
   */
  function goFuncBody(name: string): string | null {
    for (const src of fleetGoSources()) {
      const start = src.indexOf(`\nfunc ${name}(`);
      if (start === -1) continue;
      const end = src.indexOf("\nfunc ", start + 1);
      return end === -1 ? src.slice(start) : src.slice(start, end);
    }
    return null;
  }

  /** `fleet <verb>` → the Go func that handles it, read from fleetCmd's switch. */
  function fleetVerbHandlers(): Map<string, string> {
    const body = goFuncBody("fleetCmd");
    expect(body, "fleetCmd is where `fleet <verb>` dispatches").not.toBeNull();
    const out = new Map<string, string>();
    for (const block of body!.split(/^\tcase /m).slice(1)) {
      const verb = /^"([a-z][a-z-]*)":/.exec(block)?.[1];
      // `fleet[A-Z]…` so `fleetcred` and other lowercase package references
      // cannot be mistaken for a handler.
      const handler = /\b(fleet[A-Z][A-Za-z]*)\(/.exec(block)?.[1];
      if (verb && handler) out.set(verb, handler);
    }
    return out;
  }

  /**
   * The subcommands a verb's handler dispatches, parsed rather than listed, so
   * the test cannot drift from the CLI.
   *
   * Two shapes, because the CLI has two: most handlers switch on `args[0]`,
   * and `fleet nodes` compares it directly (`args[0] == "telemetry"`,
   * `args[0] != "update"`). Reading both beats hard-coding the two verbs that
   * happen to use the second shape.
   */
  function subcommandsOf(handler: string): Set<string> {
    const subs = new Set<string>();
    const body = goFuncBody(handler);
    if (!body) return subs;
    for (const [, labels] of body.matchAll(/^\s*case ((?:"[a-z][a-z-]*"(?:, )?)+):/gm)) {
      for (const [, label] of labels!.matchAll(/"([a-z][a-z-]*)"/g)) subs.add(label!);
    }
    for (const [, label] of body.matchAll(/args\[0\]\s*[!=]=\s*"([a-z][a-z-]*)"/g)) subs.add(label!);
    return subs;
  }

  interface Claim {
    page: string;
    verb: string;
    sub: string | undefined;
  }

  /**
   * Every `fleet …` command a page claims, from inline code spans AND fenced
   * code blocks.
   *
   * Prose is never scanned: a sentence like "the `fleet config` surface" would
   * read `surface` as a subcommand. The fenced blocks are where `use/cli.md`
   * keeps most of its command list, and they were unchecked entirely.
   */
  function fleetClaims(): Claim[] {
    const out: Claim[] = [];
    for (const page of all()) {
      const candidates: string[] = [];
      for (const [, span] of page.text.matchAll(/`([^`\n]+)`/g)) candidates.push(span!);
      let fenced = false;
      for (const line of page.text.split("\n")) {
        if (line.trimStart().startsWith("```")) {
          fenced = !fenced;
          continue;
        }
        if (fenced) candidates.push(line.trim());
      }
      for (const raw of candidates) {
        // One space before the subcommand, not any run of them: a usage block aligns its
        // descriptions in a column (`fleet nodes      the fleet's nodes`), and the first word of
        // a description is not a subcommand.
        const match = /^fleet\s+([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/.exec(
          raw.replace(/^\$\s*/, "").trim(),
        );
        if (match) out.push({ page: page.file, verb: match[1]!, sub: match[2] });
      }
    }
    return out;
  }

  test("every fleet subcommand named is one its verb group dispatches", () => {
    const handlers = fleetVerbHandlers();
    expect(handlers.size, "fleetCmd's switch parsed into verb → handler").toBeGreaterThan(15);

    const subs = new Map<string, Set<string>>();
    for (const [verb, handler] of handlers) subs.set(verb, subcommandsOf(handler));

    // Guards the guard. Each of these is a group whose shape the parse has to
    // cope with, and an empty set below silently skips its claims — which is
    // how this check would go vacuous without anyone noticing.
    expect(subs.get("config")?.size, "fleet config's subcommands were parsed").toBeGreaterThan(9);
    expect(subs.get("config"), "the verb the incident was about").toContain("opt-out");
    expect(subs.get("skills")?.size, "fleet skills' subcommands were parsed").toBeGreaterThan(5);
    expect(subs.get("plugins")?.size, "fleet plugins' subcommands were parsed").toBeGreaterThan(3);
    expect(subs.get("bridge")?.size, "fleet bridge's subcommands were parsed").toBeGreaterThan(3);
    // `fleet nodes` has no switch at all; it compares args[0] directly. If the
    // second pattern stops matching, this is the line that says so.
    expect(subs.get("nodes"), "fleet nodes dispatches without a switch").toContain("update");
    expect(subs.get("nodes"), "fleet nodes dispatches without a switch").toContain("telemetry");

    const verbs = new Set([...handlers.keys(), "help", "version"]);
    let checked = 0;
    for (const claim of fleetClaims()) {
      expect(verbs, `${claim.page} names \`fleet ${claim.verb}\``).toContain(claim.verb);
      if (!claim.sub) continue;
      const known = subs.get(claim.verb);
      // A handler that dispatches on flags rather than on args[0] — `fleet
      // invite`, the bare reads — yields no labels, and an empty set cannot
      // say a subcommand is wrong. Skipped rather than guessed at.
      if (!known || known.size === 0) continue;
      expect(
        known,
        `${claim.page} names \`fleet ${claim.verb} ${claim.sub}\``,
      ).toContain(claim.sub);
      checked++;
    }

    // Only the first two words are read, so `fleet skills station plan` is
    // checked as far as `station`. Third-level verbs stay unchecked; what this
    // guards is the level that was entirely unguarded.
    expect(checked, "subcommand claims were actually compared").toBeGreaterThan(40);
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
