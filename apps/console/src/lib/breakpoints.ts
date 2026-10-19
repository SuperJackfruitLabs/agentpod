/**
 * The console's breakpoints, in one place.
 *
 * Each name is the WIDEST viewport that still gets the smaller layout: a
 * component asks `(max-width: N)` for the small side and `(min-width: N+1)`
 * for the large side, so N itself is in exactly one branch. (Tailwind's
 * `max-[Npx]:` compiles to an exclusive `not all and (min-width: N)`, which
 * left N in neither branch once; do not use it for these.)
 *
 * CSS cannot import these, so `breakpoints.test.ts` reads every stylesheet and
 * component and fails on a width that is not named here.
 */
export const BREAKPOINTS = {
  /** Header actions collapse into a menu; tab strips show icons. Tailwind's `sm` is the large side. */
  header: 639,
  /** Files keeps one pane (tree or file) with a back control. */
  split: 700,
  /** Tables become cards. Tailwind's `md` is the large side. */
  cards: 767,
  /** The shell becomes the phone layout: no roster column, a bottom bar. */
  phone: 900,
  /** Touch-sized targets (44px) below this, as well as on a coarse pointer. */
  touch: 1023,
  /** No context rail: its content becomes the Identity tab. */
  rail: 1240,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/** `(max-width: Npx)`: true for the small side of `name`. */
export function upTo(name: Breakpoint): string {
  return `(max-width: ${BREAKPOINTS[name]}px)`;
}

/** `(min-width: N+1px)`: true for the large side of `name`. */
export function above(name: Breakpoint): string {
  return `(min-width: ${BREAKPOINTS[name] + 1}px)`;
}
