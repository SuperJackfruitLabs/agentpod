/**
 * Finding the environment variables the hub is prepared to NAME to an operator.
 *
 * Extracted from `tests/unit/docs-claims.test.ts` so it can be tested on its
 * own, which issue #323 showed it needed: the scanner could not tell a
 * backticked name inside a JSDoc comment from a string literal in code, and
 * reported an exported TypeScript constant as an undocumented variable.
 *
 * The check stays as it was in intent — a SCREAMING_SNAKE name inside a string
 * literal in these files is a variable being named to an operator, whether in a
 * `field:` label or the prose of a refusal. Only comments are removed first.
 */

/**
 * Remove line and block comments, leaving string literals intact.
 *
 * Written as a scanner rather than a regex on purpose. Every naive version of
 * this eats the rest of a line at the `//` in "https://hub.agentpod.dev", or
 * opens a block comment at the `/*` inside a glob string — and the damage is
 * silent, because what disappears is code the caller never sees it lost.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    // A string literal: copy it whole, respecting escapes. Nothing inside is a
    // comment, no matter what it looks like.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < source.length) {
        const ch = source[i]!;
        out += ch;
        i++;
        if (ch === "\\") {
          if (i < source.length) {
            out += source[i]!;
            i++;
          }
          continue;
        }
        if (ch === quote) break;
      }
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue; // the newline itself is copied on the next pass
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      // Keep a space so `a/* x */b` does not become `ab`.
      out += " ";
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/**
 * The SCREAMING_SNAKE names appearing in string literals in `source`, once
 * comments are gone. Sorted and de-duplicated.
 */
export function scanEnvNames(source: string): string[] {
  const named = new Set<string>();
  for (const match of stripComments(source).matchAll(/["'`]([A-Z][A-Z0-9_]{3,})["'`]/g)) {
    named.add(match[1]!);
  }
  return [...named].sort();
}
