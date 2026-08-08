import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit(), tailwindcss()],
  // Allow PUBLIC_* env vars (in addition to VITE_*) to be inlined at build time.
  // Required for import.meta.env.PUBLIC_HUB_URL used in src/lib/api/client.ts.
  envPrefix: ["VITE_", "PUBLIC_"],

  // Dev-only: proxy the hub API so a local console can iterate against a real
  // hub with working cookie auth. The hub's session cookie is SameSite=Lax, so
  // the browser only sends it in a same-site context — proxying makes every
  // request same-origin from the browser's point of view (cookies scope to
  // localhost), and the SSE log stream + terminal WebSocket ride along.
  //
  // Usage: DEV_HUB_URL=https://hub.agentpod.dev pnpm dev
  // then connect to http://localhost:5173 in the login screen.
  // Without DEV_HUB_URL the proxy targets the local hub on :3001, which is a
  // no-op for the normal local workflow (you can still connect to :3001
  // directly). NOTE: against a production hub this operates the REAL fleet.
  server: {
    proxy: {
      "/api": {
        target: process.env.DEV_HUB_URL ?? "http://localhost:3001",
        changeOrigin: true,
        ws: true,
        cookieDomainRewrite: "",
      },
      "/public": {
        target: process.env.DEV_HUB_URL ?? "http://localhost:3001",
        changeOrigin: true,
        ws: true,
      },
    },
  },

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
