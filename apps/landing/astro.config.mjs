// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://agentpod.dev",
  // The sitemap is what robots.txt points crawlers at. 404 is a page Astro builds but not
  // one anybody should find by search.
  integrations: [mdx(), sitemap({ filter: (page) => !page.includes("/404") })],
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    format: "file",
  },
  compressHTML: true,
  output: "static",
});
