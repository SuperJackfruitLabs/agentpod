/**
 * The import graph of a TypeScript (and Svelte) source tree, and the cycle finder that reads it.
 * Used by tests/unit/architecture.test.ts; see that file for what the numbers mean.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SOURCE = /\.(ts|svelte)$/;
const TEST = /(\.test\.|\.spec\.|\.d\.ts$|(^|\/)__tests__\/)/;

export function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "generated") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE.test(name) && !TEST.test(path) ? [path] : [];
  });
}

const SPECIFIER = /(?:\bfrom|\bimport\(?)\s*["']([^"']+)["']/g;

/** One import between two files of a tree, as paths relative to its root. */
export interface Import {
  from: string;
  to: string;
  /** An `import("…")` expression, which loads its file only when that code runs. */
  dynamic: boolean;
}

/** Every import inside a tree, one per file pair and kind. Imports leaving the tree (packages,
 *  other apps) are dropped. */
export function imports(rootDir: string, aliases: Record<string, string> = {}): Import[] {
  const all = sourceFiles(rootDir);
  const known = new Set(all);
  const resolveSpecifier = (from: string, spec: string): string | undefined => {
    let base: string | undefined;
    if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    for (const [alias, target] of Object.entries(aliases))
      if (spec === alias || spec.startsWith(alias + "/")) base = join(rootDir, target, spec.slice(alias.length));
    if (base === undefined) return undefined;
    const stem = base.replace(/\.js$/, "");
    for (const candidate of [base, stem + ".ts", stem + ".svelte", stem + "/index.ts"])
      if (known.has(candidate)) return candidate;
    return undefined;
  };
  const found = new Map<string, Import>();
  for (const file of all) {
    for (const m of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const to = m[1] === undefined ? undefined : resolveSpecifier(file, m[1]);
      if (to === undefined || to === file) continue;
      const edge = { from: relative(rootDir, file), to: relative(rootDir, to), dynamic: m[0].includes("(") };
      found.set(`${edge.from} ${edge.to} ${edge.dynamic}`, edge);
    }
  }
  return [...found.values()];
}

/** File-level import graph of a tree, as paths relative to its root. Edges leaving the tree
 *  (packages, other apps) are dropped. */
export function importGraph(rootDir: string, aliases: Record<string, string> = {}): Map<string, string[]> {
  const graph = new Map<string, string[]>(sourceFiles(rootDir).map((f) => [relative(rootDir, f), []] as const));
  for (const { from, to } of imports(rootDir, aliases)) {
    const targets = graph.get(from) ?? [];
    if (!targets.includes(to)) targets.push(to);
    graph.set(from, targets);
  }
  return graph;
}

/** Strongly connected components with more than one node (Tarjan), each sorted, largest first. */
export function cycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string | undefined;
    do {
      w = stack.pop();
      if (w === undefined) break;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) found.push(component.toSorted());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found.toSorted((a, b) => b.length - a.length || a.join().localeCompare(b.join()));
}

/** The graph between the entries directly under `sub` (a folder, or a file without its
 *  extension), keeping only edges whose both ends lie under it. */
export function folderGraph(graph: Map<string, string[]>, sub = ""): Map<string, string[]> {
  const prefix = sub ? sub + "/" : "";
  const folderOf = (file: string): string | undefined =>
    file.startsWith(prefix) ? file.slice(prefix.length).split("/")[0]?.replace(/\.(ts|svelte)$/, "") : undefined;
  const out = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    const a = folderOf(from);
    if (a === undefined) continue;
    const edges = out.get(a) ?? [];
    for (const to of targets) {
      const b = folderOf(to);
      if (b !== undefined && b !== a && !edges.includes(b)) edges.push(b);
    }
    out.set(a, edges);
  }
  return out;
}

