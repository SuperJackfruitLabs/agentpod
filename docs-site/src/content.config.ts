import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { sjlDocsSchema } from '@superjackfruit/docs-theme/schema';

// Starlight's schema plus the suite theme's `status:` (a status badge beside a page's title).
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: sjlDocsSchema() }),
};
