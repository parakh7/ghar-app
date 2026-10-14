import { precacheAndRoute } from "workbox-precaching";
import { offlineFallback } from "workbox-recipes";

declare const self: { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

precacheAndRoute(self.__WB_MANIFEST);

offlineFallback({ pageFallback: "/offline.html" });
