// The sidebar paints where it was last time unless something changed.
//
// Each test loads the app once (so this device has a saved copy), reloads it,
// and records every sidebar item's place every 50ms from the first paint on.
// Nothing may appear, disappear or move after the first paint — unless
// something really changed between the two loads, in which case the run is
// inconclusive and repeated (a live instance has agents working).
//
// Three ways of reloading: normally; with every server answer slowed down;
// and with the server cut off (only the sign-in check gets through — the saved
// copy alone must paint the whole sidebar). Desktop and phone sizes.
// PLAYWRIGHT_LOCAL_DIST runs it against a local build (helpers/local-dist.ts).

import { test, expect, devices, type Page } from "@playwright/test";
import { loginViaUI, readCreds } from "./helpers/auth";
import { serveLocalDist } from "./helpers/local-dist";

type Item = { key: string; top: number; left: number; marks: string };
type Sample = { t: number; items: Item[] };

const SETTLE_MS = 12_000;
const WATCH_MS = 12_000;
const ATTEMPTS = 3;

/** Installed before any page script: samples the sidebar every 50ms. */
function installSampler(page: Page) {
  return page.addInitScript((watchMs: number) => {
    const t0 = performance.now();
    const w = window as unknown as { __sidebarSamples: unknown[] };
    w.__sidebarSamples = [];
    const SELECTOR = [
      "[data-conversation-id]",
      "[data-app-key]",
      '[data-testid^="pv-project-section-header-"]',
      '[data-testid="pretty-conversations-pinned-header"]',
      '[data-testid="pv-flat-middle-section-header"]',
    ].join(",");
    const tick = () => {
      const root = document.querySelector(".pv-panel-scroll");
      const items: Item[] = [];
      if (root) {
        const rootRect = root.getBoundingClientRect();
        const seen = new Map<string, number>();
        for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
          if (el.closest("[data-sidebar-leaving]")) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const base =
            el.getAttribute("data-conversation-id") ??
            el.getAttribute("data-app-key") ??
            el.getAttribute("data-testid") ??
            "?";
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          items.push({
            key: n === 0 ? base : `${base}#${n}`,
            top: Math.round(r.top - rootRect.top + root.scrollTop),
            left: Math.round(r.left - rootRect.left),
            marks: `${el.getAttribute("data-unread") ?? ""}${el.getAttribute("data-dm") ?? ""}${el.getAttribute("data-host-unreachable") ?? ""}`,
          });
        }
      }
      w.__sidebarSamples.push({ t: Math.round(performance.now() - t0), items });
      if (performance.now() - t0 < watchMs) setTimeout(tick, 50);
    };
    tick();
  }, WATCH_MS + 8_000);
}

const layoutOf = (s: Sample) =>
  s.items.map((i) => `${i.key}@${i.top},${i.left}${i.marks}`).sort().join("\n");

async function samples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => (window as unknown as { __sidebarSamples: Sample[] }).__sidebarSamples);
}

/** The layout once the page has been sitting still. */
async function settledLayout(page: Page): Promise<string> {
  await page.waitForTimeout(SETTLE_MS);
  const all = await samples(page);
  return layoutOf(all[all.length - 1]);
}

type Mode = "normal" | "slow" | "offline";

async function cutOff(page: Page, mode: Mode) {
  if (mode === "normal") return;
  const isAsset = (path: string) => /\.(js|css|woff2?|png|webp|svg|ico|html|json)$/.test(path) || path === "/";
  if (mode === "offline") await page.routeWebSocket(/.*/, (ws) => ws.close());
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (isAsset(path) || path.endsWith("/avatar")) return route.fallback();
    if (mode === "offline") return path === "/users/me" ? route.fallback() : route.abort();
    await new Promise((r) => setTimeout(r, 2_500));
    return route.fallback();
  });
}

/** Reload and report what moved after the first paint, or null if something really changed. */
async function reloadAndCompare(page: Page, mode: Mode, before: string): Promise<string[] | null> {
  await cutOff(page, mode);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(WATCH_MS);
  const all = (await samples(page)).filter((s) => s.items.length > 0);
  expect(all.length, "the sidebar painted").toBeGreaterThan(0);
  const first = layoutOf(all[0]);
  const last = layoutOf(all[all.length - 1]);
  if (mode !== "offline" && last !== before) return null; // a real change landed
  const target = mode === "offline" ? before : last;
  const problems: string[] = [];
  if (first !== target) problems.push(`first paint differs from last time:\n${diff(first, target)}`);
  for (const s of all) {
    const l = layoutOf(s);
    if (l !== target) {
      problems.push(`at +${s.t - all[0].t}ms:\n${diff(l, target)}`);
      break;
    }
  }
  return problems;
}

function diff(a: string, b: string): string {
  const A = new Set(a.split("\n"));
  const B = new Set(b.split("\n"));
  const only = (x: Set<string>, y: Set<string>) => [...x].filter((k) => !y.has(k)).slice(0, 8);
  return `  was: ${only(A, B).join(" | ")}\n  now: ${only(B, A).join(" | ")}`;
}

// The app's offline worker would serve the live bundles ahead of a local build.
if (process.env.PLAYWRIGHT_LOCAL_DIST) test.use({ serviceWorkers: "block" });

for (const size of ["desktop", "phone"] as const) {
  test.describe(`sidebar stays put on load (${size})`, () => {
    if (size === "phone") {
      const { defaultBrowserType: _ignored, ...pixel } = devices["Pixel 7"];
      test.use(pixel);
    }
    test.setTimeout(ATTEMPTS * (SETTLE_MS + WATCH_MS + 20_000) + 30_000);

    for (const mode of ["normal", "slow", "offline"] as const) {
      test(`${mode} reload`, async ({ page, context, baseURL }) => {
        await serveLocalDist(context, baseURL!);
        await installSampler(page);
        await loginViaUI(page, readCreds());
        let problems: string[] | null = null;
        for (let attempt = 0; attempt < ATTEMPTS && problems === null; attempt++) {
          await page.unrouteAll({ behavior: "ignoreErrors" });
          await page.routeWebSocket(/.*/, (ws) => ws.connectToServer());
          await page.reload({ waitUntil: "domcontentloaded" });
          const before = await settledLayout(page);
          problems = await reloadAndCompare(page, mode, before);
        }
        test.skip(problems === null, "something really changed on every attempt");
        expect(problems, (problems ?? []).join("\n")).toEqual([]);
      });
    }
  });
}
