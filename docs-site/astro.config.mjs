// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.agentpod.dev',
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
