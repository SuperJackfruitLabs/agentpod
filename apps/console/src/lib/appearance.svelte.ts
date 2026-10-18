/**
 * The person's appearance: vibe, light/dark/follow the sun, time-of-day strength, and whether the
 * sun follows their rough location. It belongs to the person (spec: vibekit "The person's
 * appearance setting"); until Accounts stores it, it lives in a cookie on this host.
 *
 * `app.html` already painted the first frame from the same cookie and the device clock
 * (vibekit HEAD_SCRIPT). This refines the phase with the time zone or the rough place, keeps it
 * current, and writes every change back.
 *
 * The place never leaves the device: it is rounded to one decimal (about 11 km), kept in
 * localStorage, and only ever handed to phaseAt().
 */
import {
  appearanceCookie,
  accentFor,
  appearanceFromCookieHeader,
  defaultTimeStrength,
  DEFAULT_APPEARANCE,
  htmlAttributes,
  phaseAt,
  resolveTheme,
  withAccent,
  type AccentChoice,
  type Appearance,
  type Phase,
  type Place,
  type Theme,
} from '@superjackfruit/vibekit';

const PRODUCT = 'agentpod' as const;
const PLACE_KEY = 'agentpod.place';
/** The old theme system's keys (removed with it). The mode seeds the appearance once; all are then cleared. */
const LEGACY_MODE_KEY = 'agentpod-theme-mode';
export const LEGACY_KEYS = [LEGACY_MODE_KEY, 'agentpod-color-scheme', 'agentpod-font-pairing', 'agentpod-custom-themes'] as const;
const TICK_MS = 60_000;

export const roughPlace = (p: Place): Place => ({
  latitude: Math.round(p.latitude * 10) / 10,
  longitude: Math.round(p.longitude * 10) / 10,
});

function readPlace(): Place | null {
  try {
    const raw = localStorage.getItem(PLACE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Place>;
    return typeof p.latitude === 'number' && typeof p.longitude === 'number' && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
      ? roughPlace({ latitude: p.latitude, longitude: p.longitude })
      : null;
  } catch {
    return null;
  }
}

function forgetPlace(): void {
  try { localStorage.removeItem(PLACE_KEY); } catch { /* storage blocked: nothing was stored either */ }
}

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => unknown };

export class AppearanceStore {
  value = $state<Appearance>({ ...DEFAULT_APPEARANCE });
  phase = $state<Phase>('noon');
  place = $state<Place | null>(null);
  pickerOpen = $state(false);
  theme: Theme = $derived(resolveTheme(this.value.theme, this.phase));
  accent: AccentChoice = $derived(accentFor(this.value, PRODUCT));

  #timer: ReturnType<typeof setInterval> | undefined;
  #now: () => Date = () => new Date();
  #write: (cookie: string) => void;
  /** Bumped whenever a location request starts or is called off, so a late answer can tell it was. */
  #locationRequest = 0;

  constructor(write: (cookie: string) => void = (c) => { document.cookie = c; }) {
    this.#write = write;
  }

  init(now: () => Date = () => new Date()): void {
    this.#now = now;
    this.#seedFromLegacy();
    this.value = appearanceFromCookieHeader(document.cookie);
    this.place = this.value.useLocation ? readPlace() : null;
    this.#apply(false);
    this.#themeColour();
    clearInterval(this.#timer);
    this.#timer = setInterval(() => this.#apply(false), TICK_MS);
  }

  dispose(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  set(next: Partial<Appearance>): void {
    const prev = this.value;
    const merged: Appearance = { ...prev, ...next };
    if (next.vibe && next.vibe !== prev.vibe && next.timeStrength === undefined && prev.timeStrength === defaultTimeStrength(prev.vibe)) {
      merged.timeStrength = defaultTimeStrength(next.vibe);
    }
    if (!merged.useLocation) {
      this.place = null;
      forgetPlace();
    }
    this.value = merged;
    try {
      this.#write(appearanceCookie(merged, { secure: location.protocol === 'https:' }));
    } catch { /* cookies blocked: the choice still holds for this tab */ }
    this.#apply(true);
  }

  setAccent(choice: AccentChoice): void {
    this.set(withAccent(this.value, PRODUCT, choice));
  }

  /** Light or Dark, explicitly: the opposite of what is showing now. */
  toggleTheme(): void {
    this.set({ theme: this.theme === 'dark' ? 'light' : 'dark' });
  }

  /** Location off, and the saved place forgotten. Also calls off any request still waiting. */
  stopUsingLocation(): void {
    this.#locationRequest++;
    this.set({ useLocation: false });
  }

  async useLocation(geo: Geolocation | undefined = globalThis.navigator?.geolocation): Promise<'on' | 'denied' | 'cancelled'> {
    const request = ++this.#locationRequest;
    if (!geo) {
      this.set({ useLocation: false });
      return 'denied';
    }
    try {
      const pos = await new Promise<GeolocationPosition>((ok, no) =>
        geo.getCurrentPosition(ok, no, { enableHighAccuracy: false, maximumAge: 86_400_000, timeout: 10_000 }),
      );
      if (request !== this.#locationRequest) return 'cancelled';
      const place = roughPlace({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      try { localStorage.setItem(PLACE_KEY, JSON.stringify(place)); } catch { /* kept for this tab only */ }
      this.place = place;
      this.set({ useLocation: true });
      return 'on';
    } catch {
      if (request !== this.#locationRequest) return 'cancelled';
      this.set({ useLocation: false });
      return 'denied';
    }
  }

  /**
   * The old console saved light / dark / system / auto in localStorage. A light or dark choice
   * becomes the appearance cookie once (app.html does the same before the first paint); system and
   * auto are what following the sun already means. Every old key is then forgotten.
   */
  #seedFromLegacy(): void {
    try {
      const mode = localStorage.getItem(LEGACY_MODE_KEY);
      if ((mode === 'light' || mode === 'dark') && !/(?:^|; )vk_appearance=/.test(document.cookie)) {
        const seeded: Appearance = { ...DEFAULT_APPEARANCE, theme: mode };
        this.#write(appearanceCookie(seeded, { secure: location.protocol === 'https:' }));
      }
      for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    } catch { /* storage or cookies blocked: nothing to carry over */ }
  }

  #phaseNow(): Phase {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return phaseAt(this.#now(), this.place ? { place: this.place } : { timeZone });
  }

  #apply(animate: boolean): void {
    this.phase = this.#phaseNow();
    // Every attribute, data-product included. VibeRoot writes the same vibe and theme from this
    // store's values, so the two never disagree; writing them here too keeps <html> right before
    // the layout mounts.
    const attrs: Record<string, string> = { ...htmlAttributes(this.value, this.phase, PRODUCT) };
    const el = document.documentElement;
    if (Object.entries(attrs).every(([k, v]) => el.getAttribute(k) === v)) return;
    const paint = () => {
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      this.#themeColour();
    };
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const doc = document as ViewTransitionDoc;
    if (animate && !reduce && typeof doc.startViewTransition === 'function') doc.startViewTransition(paint);
    else paint();
  }

  #themeColour(): void {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--vk-color-bg').trim();
    if (!bg) return;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));
  }
}

export const appearance = new AppearanceStore();
