/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use shared package source directly in dev/test for instant HMR.
    alias: { "@household/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)) },
  },
  server: {
    port: 5173,
    // Same-origin in dev: SameSite cookies and CSRF origin checks behave like production.
    proxy: { "/api": { target: "http://localhost:4000", changeOrigin: false } },
  },
  build: { target: "es2022", sourcemap: true },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], css: false },
});
