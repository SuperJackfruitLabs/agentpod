/**
 * The hub's public surface, read from the code with the TypeScript parser, and the current docs
 * it is checked against. Used by tests/unit/docs-claims.test.ts (the completeness ratchet); see
 * that file for what it asserts.
 *
 * Four surfaces:
 *  - routes: every `METHOD /path` the hub serves, found by walking the Hono mounts from
 *    `src/index.ts` (`.route(prefix, router)`) into the router each one names, and collecting
 *    every `.get/.post/.put/.patch/.delete/.all(path, …)` registered on it;
 *  - env: every environment variable `src/` reads (`process.env.X`, `process.env[X]`,
 *    `Bun.env.X`, `import.meta.env.X`, an `env.X` parameter, the `getEnv*("X")` helpers in
 *    config.ts, and a helper handed the environment and a name, `str(env, "X")`);
 *  - events: every Matrix event type or content key, and every relay (CloudEvent) type, the hub
 *    or the contract package names in a string (`dev.agentpod.*`, `dev.superpipeline.*`,
 *    `com.superjackfruit.*`). Types the hub imports from Treaty are Treaty's, documented there;
 *    this reads only the ones defined here;
 *  - push: the SuperPipeline push events the bridge subscribes to (`push-subscription.ts`).
 *
 * The AST rather than a regex because the mounts are not one shape: a router is an imported
 * const, a factory call, a local `app` built up statement by statement, or a router that mounts
 * routers of its own (`admin.ts`). A regex over the text cannot tell which file a prefix applies
 * to; the parser follows the import.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export const REPO = join(import.meta.dir, "../../../..");
const HUB_SRC = join(REPO, "apps/hub/src");
const TEST = /(\.test\.|\.spec\.|\.d\.ts$|(^|\/)__tests__\/)/;

// ─── Parsing ────────────────────────────────────────────────────────────────

const parsed = new Map<string, ts.SourceFile>();
function source(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, sf);
  }
  return sf;
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "generated") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith(".ts") && !TEST.test(path) ? [path] : [];
  });
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** A string literal's text, or a constant declared in the same file as one. */
function stringValue(node: ts.Expression, sf: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    let found: string | undefined;
    walk(sf, (n) => {
      if (
        found === undefined &&
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === node.text &&
        n.initializer &&
        (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))
      )
        found = n.initializer.text;
    });
    return found;
  }
  return undefined;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const METHODS = new Set(["get", "post", "put", "patch", "delete", "all"]);

export interface Route {
  method: string;
  path: string;
  /** Where it is registered, `file:line`, for the failure message. */
  at: string;
}

function resolveModule(from: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return undefined;
}

/** Where `name`, as used in `file`, is declared: its file and its name there. */
function definitionOf(file: string, name: string, seen = new Set<string>()): { file: string; name: string } | undefined {
  const key = `${file}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const sf = source(file);
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return { file, name };
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === name) return { file, name };
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveModule(file, stmt.moduleSpecifier.text);
      const clause = stmt.importClause;
      if (!target || !clause) continue;
      if (clause.name?.text === name) return definitionOf(target, "default", seen);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const el of clause.namedBindings.elements)
          if (el.name.text === name) return definitionOf(target, (el.propertyName ?? el.name).text, seen);
    }
    // `export { x } from "./y"` and `export * from "./y"`, as a module's index re-exports.
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveModule(file, stmt.moduleSpecifier.text);
      if (!target) continue;
      if (!stmt.exportClause) {
        const found = definitionOf(target, name, seen);
        if (found) return found;
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements)
          if (el.name.text === name) return definitionOf(target, (el.propertyName ?? el.name).text, seen);
      }
    }
    // `export default x`
    if (name === "default" && ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression))
      return definitionOf(file, stmt.expression.text, seen);
  }
  return undefined;
}

/** The nodes that build the router `name` in `file`: a function's body, or a const and every
 *  top-level statement that adds to it. */
function routerNodes(file: string, name: string): ts.Node[] {
  const sf = source(file);
  const out: ts.Node[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) out.push(stmt.body);
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) out.push(d.initializer);
    if (ts.isExpressionStatement(stmt) && rootIdentifier(stmt.expression) === name) out.push(stmt);
  }
  return out;
}

/** `a.b(…).c(…)` → `a`. */
function rootIdentifier(expr: ts.Expression): string | undefined {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e)) e = e.expression;
    else break;
  }
  return ts.isIdentifier(e) ? e.text : undefined;
}

/** The factory calls an expression may evaluate to: `f()`, or either side of `c ? f() : g()`. */
function returnedCalls(e: ts.Expression): ts.CallExpression[] {
  if (ts.isParenthesizedExpression(e)) return returnedCalls(e.expression);
  if (ts.isConditionalExpression(e)) return [...returnedCalls(e.whenTrue), ...returnedCalls(e.whenFalse)];
  return ts.isCallExpression(e) ? [e] : [];
}

function join2(prefix: string, path: string): string {
  const p = prefix.replace(/\/+$/, "");
  if (path === "" || path === "/") return p || "/";
  return `${p}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Every route registered within `nodes` (of `file`) and in the routers they mount, under `prefix`. */
function routesIn(file: string, nodes: ts.Node[], prefix: string, out: Route[], seen: Set<string>): void {
  const sf = source(file);
  const at = (n: ts.Node) => `${relative(REPO, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const follow = (expr: ts.Expression, under: string) => {
    // A router is named directly, or built by a factory call, perhaps behind a `cond ? a : b`.
    let target = expr;
    if (ts.isCallExpression(target)) target = target.expression;
    if (!ts.isIdentifier(target)) return;
    const def = definitionOf(file, target.text);
    if (!def) return;
    const key = `${def.file}#${def.name}@${under}`;
    if (seen.has(key)) return;
    seen.add(key);
    routesIn(def.file, routerNodes(def.file, def.name), under, out, seen);
  };
  for (const root of nodes) {
    walk(root, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const method = n.expression.name.text;
      const [first, second] = n.arguments;
      if (!first || !second) return;
      const path = stringValue(first, sf);
      if (path === undefined || (path !== "" && !path.startsWith("/"))) return;
      if (method === "route") follow(second, join2(prefix, path));
      // `at` the method's name, not the call: a chained call starts where the chain does.
      else if (METHODS.has(method)) out.push({ method: method.toUpperCase(), path: join2(prefix, path), at: at(n.expression.name) });
      else if (method === "on" && ts.isStringLiteral(first)) {
        // `.on("GET", "/x", …)`: the method first, the path second.
        const p = stringValue(second, sf);
        if (p !== undefined && p.startsWith("/"))
          out.push({ method: first.text.toUpperCase(), path: join2(prefix, p), at: at(n.expression.name) });
      }
    });
    // A const built by a factory (`export const r = createR()`), or a factory that hands back
    // another factory's router (`return createX(…)`).
    if (ts.isCallExpression(root) && ts.isIdentifier(root.expression)) follow(root, prefix);
    walk(root, (n) => {
      if (ts.isReturnStatement(n) && n.expression) for (const call of returnedCalls(n.expression)) follow(call, prefix);
    });
  }
}

/** Every route the hub serves, deduplicated by method and path. */
export function hubRoutes(): Route[] {
  const index = join(HUB_SRC, "index.ts");
  const out: Route[] = [];
  routesIn(index, [source(index)], "", out, new Set());
  const byKey = new Map<string, Route>();
  for (const r of out) if (!byKey.has(`${r.method} ${r.path}`)) byKey.set(`${r.method} ${r.path}`, r);
  return [...byKey.values()].toSorted((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

// ─── Environment variables ──────────────────────────────────────────────────

const ENV_NAME = /^[A-Z][A-Z0-9_]*[A-Z0-9]$/;
/** The operating system's, not the hub's. */
const OS_VARS = new Set(["HOME", "PATH", "USER", "SHELL", "PWD", "TMPDIR", "TZ", "LANG", "HOSTNAME"]);
const ENV_HELPERS = new Set(["getEnv", "getEnvInt", "getEnvBool"]);

function isEnvObject(e: ts.Expression): boolean {
  // `process.env`, `Bun.env`, `import.meta.env`, or a parameter or local named `env`.
  if (ts.isIdentifier(e)) return e.text === "env";
  if (ts.isPropertyAccessExpression(e) && e.name.text === "env")
    return ts.isIdentifier(e.expression) ? ["process", "Bun"].includes(e.expression.text) : ts.isMetaProperty(e.expression);
  return false;
}

/** Every environment variable read under `dirs` (repo-relative), with where it is first read. */
export function envVars(dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of dirs)
    for (const file of tsFiles(join(REPO, dir))) {
      const sf = source(file);
      const add = (name: string | undefined, n: ts.Node) => {
        if (!name || !ENV_NAME.test(name) || OS_VARS.has(name) || out.has(name)) return;
        out.set(name, `${relative(REPO, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      };
      walk(sf, (n) => {
        if (ts.isPropertyAccessExpression(n) && isEnvObject(n.expression)) add(n.name.text, n);
        if (ts.isElementAccessExpression(n) && isEnvObject(n.expression)) add(stringValue(n.argumentExpression, sf), n);
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ENV_HELPERS.has(n.expression.text) && n.arguments[0])
          add(stringValue(n.arguments[0], sf), n);
        // A helper handed the environment and a name: `str(env, "DOCKER_HOST", "")`.
        if (ts.isCallExpression(n) && n.arguments.some(isEnvObject))
          for (const arg of n.arguments) if (ts.isStringLiteral(arg)) add(arg.text, n);
      });
    }
  return out;
}

// ─── Matrix event types and push events ─────────────────────────────────────

const MATRIX_TYPE = /^(?:dev\.(?:agentpod|superpipeline)|com\.superjackfruit)(?:\.[a-z0-9_]+)+$/;

/** Every Matrix event type, content key or relay event type named in a string under `dirs`. */
export function matrixTypes(dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of dirs)
    for (const file of tsFiles(join(REPO, dir))) {
      const sf = source(file);
      walk(sf, (n) => {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && MATRIX_TYPE.test(n.text) && !out.has(n.text))
          out.set(n.text, `${relative(REPO, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      });
    }
  return out;
}

/** The string elements of `export const NAME = [ … ] as const` in `file`. */
export function constList(file: string, name: string): string[] {
  const sf = source(join(REPO, file));
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
      let init: ts.Expression = d.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      if (!ts.isArrayLiteralExpression(init)) break;
      return init.elements.flatMap((e) => (ts.isStringLiteral(e) ? [e.text] : []));
    }
  }
  throw new Error(`no array ${name} in ${file}`);
}

// ─── The docs ───────────────────────────────────────────────────────────────

/** Dated records in docs/: specs, plans, audits, research and release notes. Where one and the
 *  code disagree, the code wins (docs/README.md), so naming something there documents nothing. */
const DATED = /^docs\/(archive|superpowers|strategy|research|implementation)\/|^docs\/(RELEASE-|UI-UX-AUDIT-)/;

/** Markdown under `dir`, not descending into a dated folder (docs/archive holds dangling links). */
function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || DATED.test(`${relative(REPO, path)}/`)) return [];
    if (statSync(path).isDirectory()) return mdFiles(path);
    return /\.mdx?$/.test(name) ? [path] : [];
  });
}

/** The current documentation: the published site, the runbooks in docs/ and the READMEs. */
export function currentDocs(): Map<string, string> {
  const files = [
    ...mdFiles(join(REPO, "docs-site/src/content/docs")),
    ...mdFiles(join(REPO, "docs")),
    ...["README.md", "CONTRIBUTING.md", ...readdirSync(join(REPO, "apps")).map((a) => `apps/${a}/README.md`)]
      .map((f) => join(REPO, f))
      .filter(existsSync),
  ];
  return new Map(files.map((f) => [relative(REPO, f), readFileSync(f, "utf8")]));
}

/** `fs/{write,mkdir}` → `fs/write`, `fs/mkdir`: the shorthand the runbooks use for siblings. */
function expandBraces(line: string): string[] {
  const m = /\{([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)+)\}/.exec(line);
  const alts = m?.[1];
  if (!m || !alts) return [line];
  return alts.split(",").flatMap((alt) => expandBraces(line.slice(0, m.index) + alt + line.slice(m.index + m[0].length)));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a route is named: its path (any spelling of each parameter) and its method on one line. */
export function routeNamed(route: Route, lines: string[]): boolean {
  const path = route.path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "(?::[A-Za-z_]+|\\{[^}/]+\\}|<[^>/]+>|[^/\\s`)]+)" : escape(seg)))
    .join("/");
  const pathRe = new RegExp(`(?<![A-Za-z0-9_/-])${path}(?![A-Za-z0-9_/-])`);
  const methodRe = route.method === "ALL" ? /./ : new RegExp(`\\b(?:${route.method}${route.method === "GET" ? "|WS" : ""})\\b`);
  return lines.some((line) => methodRe.test(line) && pathRe.test(line));
}

/** Whether a name (a setting, an event type) appears as a whole token. */
export function nameNamed(name: string, text: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_.])${escape(name)}(?![A-Za-z0-9_]|\\.[A-Za-z0-9_])`).test(text);
}

/** Every line of the current docs, with brace shorthand expanded. */
export function docLines(docs: Map<string, string>): string[] {
  return [...docs.values()].flatMap((text) => text.split("\n")).flatMap(expandBraces);
}
