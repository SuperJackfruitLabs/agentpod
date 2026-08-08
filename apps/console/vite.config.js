import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit(), tailwindcss()],
  // Allow PUBLIC_* env vars (in addition to VITE_*) to be inlined at build time.
  // Required for import.meta.env.PUBLIC_HUB_URL used in src/lib/api/client.ts.
  envPrefix: ["VITE_", "PUBLIC_"],

  // Mark dev-only packages as external for SSR builds (they're dynamically imported only in dev mode)
  ssr: {
    external: [],
  },
  optimizeDeps: {
    exclude: [],
  },
  build: {
    rollupOptions: {
      external: [],
    },
  },
}));
