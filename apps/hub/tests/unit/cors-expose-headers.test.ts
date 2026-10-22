/**
 * The console runs on another origin, so a response header is invisible to it unless
 * Access-Control-Expose-Headers lists it. `X-Truncated` (set by GET /api/stations/:id/file
 * when a read is cut short) was missing, so the console could never see the cut.
 *
 * Mounts the real CORS middleware on a bare Hono app; importing src/index.ts would boot the hub.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { corsMiddleware } from '../../src/middleware/cors.ts';

const CONSOLE_ORIGIN = 'https://console.agentpod.dev';

describe('CORS exposed headers', () => {
  const app = new Hono().use('*', corsMiddleware).get('/probe', (c) => {
    c.header('X-Truncated', 'true');
    return c.text('x');
  });

  test('a cross-origin request from the console exposes X-Truncated', async () => {
    const res = await app.request('/probe', { headers: { Origin: CONSOLE_ORIGIN } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CONSOLE_ORIGIN);
    const exposed = (res.headers.get('Access-Control-Expose-Headers') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase());
    expect(exposed).toContain('x-truncated');
    expect(exposed).toContain('x-ratelimit-limit');
  });
});

describe('CORS allowed origin', () => {
  const app = new Hono().use('*', corsMiddleware).get('/probe', (c) => c.text('x'));

  test('an allowed origin is echoed', async () => {
    const res = await app.request('/probe', { headers: { Origin: CONSOLE_ORIGIN } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CONSOLE_ORIGIN);
  });

  // Spec 2026-10-23 Q5: staging answered "http://localhost:5173" to every request without an
  // Origin, because the middleware fell back to the first default origin (the Vite dev server).
  test('no Origin gets no Access-Control-Allow-Origin, never the dev server', async () => {
    const res = await app.request('/probe');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('a disallowed origin gets no Access-Control-Allow-Origin', async () => {
    const res = await app.request('/probe', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('the staging hub allows the staging console', async () => {
    const compose = await Bun.file(new URL('../../../../deploy/staging/compose.yml', import.meta.url)).text();
    const line = compose.split('\n').find((l) => l.trim().startsWith('ALLOWED_ORIGINS:'));
    expect(line?.split(':').slice(1).join(':').split(',').map((o) => o.trim())).toContain(
      'https://staging-console.agentpod.dev',
    );
  });
});
