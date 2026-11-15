// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sjlDocs from '@superjackfruitlabs/vibekit-docs';

export default defineConfig({
  site: 'https://docs.agentpod.dev',
  // Astro turns on Vite's tsconfig path resolution unconditionally, and Vite
  // 8's native resolver then discovers tsconfigs across the whole monorepo. It
  // follows the root tsconfig's `references` into apps/console, whose tsconfig
  // extends `.svelte-kit/tsconfig.json`, a file `svelte-kit sync` generates and
  // git does not have. On any machine that has built the console it is there;
  // on a fresh CI checkout it is not, and `astro sync` fails:
  //
  //   Tsconfig not found apps/console/.svelte-kit/tsconfig.json
  //
  // This site defines no path aliases, so it loses nothing by turning it off.
  // Output is byte-identical either way.
  vite: { resolve: { tsconfigPaths: false } },
  integrations: [
    starlight({
      title: 'AgentPod',
      description:
        'A fleet and facilities console for agent runtimes. Docs for running a fleet, ' +
        'operating the machines your agents live on, and building against the hub.',
      // The suite's docs theme: vibekit's cobalt, the faces, the street, status badges, the footers,
      // the 404, the edit link and llms.txt. See @superjackfruitlabs/vibekit-docs's README.
      plugins: [
        sjlDocs({
          product: 'agentpod',
          status: 'lights on',
          // /llms.txt, /llms-full.txt and /llms-small.txt, for agents reading these docs.
          llms: {
            description:
              'AgentPod is a fleet and facilities console for agent runtimes: the console for the ' +
              'machines your agents live on. It attaches to runtimes you already run, detecting Claude ' +
              'Code, Codex, OpenCode, Hermes, OpenClaw and Pi in place rather than asking you to ' +
              'migrate anything. Every node dials out to the hub over a WebSocket, so a laptop behind ' +
              'NAT works the same as a VPS. From one place you can read a workspace, tail a log, open a ' +
              'shell and check health on any station; turn on the bridge and each station gets a chat ' +
              'identity you can message, and managed skills can be verified as actually loaded. The hub ' +
              'is a Bun service with a Postgres database and the console is a static site, all ' +
              'self-hosted.',
          },
        }),
      ],
      favicon: '/favicon.svg',
      head: [
        // Starlight writes og:title, og:description and og:url per page, but no image. The
        // image is agentpod.dev's (apps/landing/og/), by absolute URL.
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://agentpod.dev/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://agentpod.dev/og.png' } },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/SuperJackfruitLabs/agentpod' },
      ],
      // The suite's five groups, in the order a reader needs them. No page moved, so no URL changed.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'What AgentPod is', slug: 'start/what-it-is' },
            { label: 'Your first node', slug: 'start/first-node' },
            { label: 'Concepts', slug: 'start/concepts' },
          ],
        },
        {
          label: 'Use it',
          items: [
            { label: 'Stations', slug: 'use/stations' },
            { label: 'What you can do to a station', slug: 'use/panels' },
            { label: 'Managed skills', slug: 'use/skills' },
            { label: 'Talking to an agent in a room', slug: 'use/rooms' },
            { label: 'Voice notes', slug: 'use/voice' },
            { label: 'When a turn fails', slug: 'use/errors' },
            { label: 'Declared harness settings', slug: 'use/config' },
            { label: 'Working a board', slug: 'use/boards' },
            { label: 'Dispatch and grants', slug: 'use/grants' },
            { label: 'Attaching an editor', slug: 'use/acp' },
          ],
        },
        {
          label: 'Build on it',
          items: [
            { label: 'MCP tools', slug: 'build/mcp' },
            { label: 'Authentication', slug: 'build/auth' },
            { label: 'Capability catalog', slug: 'build/catalog' },
            { label: 'Reads for services', slug: 'build/services' },
          ],
        },
        {
          label: 'Run it',
          items: [
            { label: 'Nodes', slug: 'use/nodes' },
            { label: 'apn and fleet', slug: 'use/cli' },
            { label: 'Checking for exposure', slug: 'use/scan' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'apn', slug: 'reference/apn' },
            { label: 'fleet', slug: 'reference/fleet' },
          ],
        },
      ],
    }),
  ],
});
