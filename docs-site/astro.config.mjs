// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

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
            { label: 'The apn command', slug: 'use/cli' },
            { label: 'Checking for exposure', slug: 'use/scan' },
            { label: 'Attaching an editor', slug: 'use/acp' },
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
