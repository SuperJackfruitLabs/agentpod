// @superjackfruitlabs/vibekit-docs 0.0.2 ships its schema as plain JavaScript (src/schema.mjs) with no
// declaration, and `npm run check` (astro check) runs under `strict`, so without this the import in
// content.config.ts fails with TS7016. sjlDocsSchema() is Starlight's docsSchema() extended with
// the theme's `status` field; it is typed here as Starlight's, which is all this site relies on.
// Drop this file once the theme ships its own declaration.
declare module '@superjackfruitlabs/vibekit-docs/schema' {
  import type { docsSchema } from '@astrojs/starlight/schema';
  export function sjlDocsSchema(): ReturnType<typeof docsSchema>;
}
