// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

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
      // /llms.txt, /llms-full.txt and /llms-small.txt, for agents reading these docs. The
      // full file carries every page, reference pages included; the small one drops asides
      // and <details> but keeps every page too, since nothing here is noise.
      plugins: [
        starlightLlmsTxt({
          projectName: 'AgentPod',
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
          optionalLinks: [
            { label: 'AgentPod', url: 'https://agentpod.dev', description: 'The product site.' },
            { label: 'Source', url: 'https://github.com/SuperJackfruitLabs/agentpod', description: 'The AgentPod repository on GitHub.' },
          ],
        }),
      ],
      // The mark and palette are agentpod.dev's; see src/styles/theme.css for where each
      // value comes from. Two logo files because an <img> cannot follow the theme's colours.
      logo: { light: './src/assets/mark-light.svg', dark: './src/assets/mark-dark.svg', alt: '' },
      customCss: ['./src/styles/theme.css'],
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href:
              'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800' +
              '&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
          },
        },
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
            { label: 'Nodes', slug: 'use/nodes' },
            { label: 'Stations', slug: 'use/stations' },
            { label: 'What you can do to a station', slug: 'use/panels' },
            { label: 'Managed skills', slug: 'use/skills' },
            { label: 'Talking to an agent in a room', slug: 'use/rooms' },
            { label: 'Voice notes', slug: 'use/voice' },
            { label: 'When a turn fails', slug: 'use/errors' },
            { label: 'Declared harness settings', slug: 'use/config' },
            { label: 'Working a board', slug: 'use/boards' },
            { label: 'Dispatch and grants', slug: 'use/grants' },
            { label: 'apn and fleet', slug: 'use/cli' },
            { label: 'Checking for exposure', slug: 'use/scan' },
            { label: 'Attaching an editor', slug: 'use/acp' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'apn', slug: 'reference/apn' },
            { label: 'fleet', slug: 'reference/fleet' },
          ],
        },
        {
          label: 'Build on it',
          items: [
            { label: 'MCP tools', slug: 'build/mcp' },
            { label: 'Authentication', slug: 'build/auth' },
          ],
        },
      ],
    }),
  ],
});
