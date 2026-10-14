/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"] },
      includeAssets: ["icon.svg", "favicon.ico", "apple-touch-icon-180x180.png", "maskable-icon-512x512.png", "pwa-64x64.png"],
      manifest: {
        name: "Ghar — household manager",
        short_name: "Ghar",
        description: "Househelp, attendance, bills and reminders for your home — in one place.",
        theme_color: "#C2410C",
        background_color: "#FAF7F2",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
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
