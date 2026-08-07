// adapter-static prerenders the app as an SPA (SSG) for web deployment
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: [vitePreprocess()],
  kit: {
    adapter: adapter({
      // Fallback page for dynamic routes in SPA mode
      fallback: "index.html",
    }),
    prerender: {
      // Dynamic routes like /projects/[id] cannot be prerendered
      // They will use client-side routing via the fallback page
      handleUnseenRoutes: "ignore",
    },
  },
};

export default config;
