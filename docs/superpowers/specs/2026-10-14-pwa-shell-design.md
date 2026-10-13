# PWA Shell — Design Spec

**Phase:** 9 (PWA, offline cache and mutation queue, mobile polish) — Spec 1 of 3.

**Status:** Approved.

## Context

Phase 9's roadmap text bundles three independent subsystems: the PWA shell (installability — manifest, service worker, icons), the offline mutation queue (replaying writes made while offline), and mobile polish (unscoped). This spec covers only the PWA shell — the foundation the offline queue will build on. Groundwork already in the codebase: `theme-color` meta tags for light/dark, `viewport-fit=cover`, and a single `apps/web/public/icon.svg`. No manifest, service worker, or PNG icons exist yet.

## Scope

- Add a web app manifest (`manifest.webmanifest`) describing the app for install.
- Register a service worker that precaches the built app shell (JS/CSS bundles, fonts, icons) so the app loads instantly offline once it has been opened at least once.
- Generate the PNG icon set (192×192, 512×512, maskable, apple-touch-icon) from the existing `icon.svg` as part of the build — no new hand-maintained binary assets.
- Serve a dedicated offline fallback page for navigations that miss the precache while the network is unreachable.
- Auto-update the service worker silently on new deploys — no user-facing "update available" prompt.

**Out of scope (deliberately):**
- Caching API responses / showing stale data offline — that's the offline-mutation-queue spec's territory.
- A custom "Install app" button/banner — rely on each browser's native install affordance.
- Web push delivery (separate, already partially scoped under Phase 7's `push_subscriptions` table — not touched here).

## Architecture

Use `vite-plugin-pwa` (Workbox under the hood) in `apps/web`'s Vite config:
- `registerType: 'autoUpdate'` — the new service worker activates and takes over automatically; the user sees the new version on their next load/refresh, no prompt.
- `workbox.globPatterns` precaches the built JS/CSS/font/icon assets.
- `workbox.navigateFallback` points at the offline fallback route for uncached navigations when offline.
- `includeAssets` picks up `icon.svg` and the generated PNGs.

Icon generation: `@vite-pwa/assets-generator`, configured to rasterize `apps/web/public/icon.svg` into the manifest's required sizes (192, 512, maskable variant, apple-touch-icon) as part of the build pipeline (a `predev`/`prebuild` script or equivalent), so the icons regenerate automatically if `icon.svg` is redesigned later.

## Manifest content

- `name`: "Ghar — household manager"
- `short_name`: "Ghar"
- `description`: reuse the existing `<meta name="description">` text
- `theme_color`: `#C2410C` (the light-mode value — manifest has no media-query support, so this is the single value used by the OS install UI)
- `background_color`: `#FAF7F2` (the `--paper` token — the app's light-mode page background)
- `display`: `"standalone"`
- `start_url`: `"/"`
- `icons`: the generated 192/512/maskable PNG set

## Offline fallback page

A plain React route/component (not part of the SPA's router — served directly by the service worker's `navigateFallback` as a static precached HTML page, independent of `main.tsx`'s React Router tree) showing "You're offline" and a retry button that reloads the page. Styled minimally using the existing design tokens (CSS variables) so it doesn't look broken, but does not depend on the app's JS bundle having loaded.

## Testing

- The offline fallback page's markup/behavior (retry button reloads) gets a normal component/DOM test.
- `vite-plugin-pwa`'s generated service worker and Workbox precaching are not meaningfully unit-testable — verification is a manual build (`npm run build --workspace @household/web`) followed by a manual Lighthouse PWA audit and a manual "add to home screen" check in a real browser. This is documented as a manual verification step in the implementation plan, not an automated test.
- Confirm the build still passes typecheck and the existing test suite (no regressions from the new Vite plugin).
