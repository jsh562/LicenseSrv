import { defineConfig } from "vite";

// The live-issue tab talks to the running LicenseSrv API. The server sets NO CORS, so — exactly like
// the admin console (src/admin-ui/vite.config.ts) — we proxy same-origin so session + CSRF cookies
// stay first-party. The offline modes need no server at all (they use the bundled demo-bundle.json).
export default defineConfig({
  server: {
    proxy: {
      "/admin": { target: "http://localhost:8080", changeOrigin: false },
      "/v1": { target: "http://localhost:8080", changeOrigin: false },
    },
  },
});
