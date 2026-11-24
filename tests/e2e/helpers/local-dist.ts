import type { BrowserContext } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * PLAYWRIGHT_LOCAL_DIST=<dir of a `vite build`>: serve the page and its
 * bundles from that local build while every API call still goes to
 * PLAYWRIGHT_BASE_URL — to try a frontend change against a live instance
 * before deploying it. Build it with VITE_BUILD_ID set to the live server's
 * build (its X-Skynet-Server-Build header) or the server refuses its calls,
 * and block service workers in the spec (`test.use({ serviceWorkers: "block" })`)
 * or the app's offline worker serves the live bundles instead.
 */
export async function serveLocalDist(context: BrowserContext, baseURL: string): Promise<void> {
  const dist = process.env.PLAYWRIGHT_LOCAL_DIST;
  if (!dist) return;
  const origin = new URL(baseURL).origin;
  await context.route("**/*", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== origin) return route.fallback();
    if (u.pathname.startsWith("/assets/")) {
      const f = path.join(dist, u.pathname);
      return fs.existsSync(f) ? route.fulfill({ path: f }) : route.fallback();
    }
    if (req.resourceType() === "document") {
      return route.fulfill({ path: path.join(dist, "index.html"), contentType: "text/html" });
    }
    return route.fallback();
  });
}
