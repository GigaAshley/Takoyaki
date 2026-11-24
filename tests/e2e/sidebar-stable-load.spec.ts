// The sidebar paints where it was last time unless something changed.
//
// Each test loads the app once (so this device has a saved copy), reloads it,
// and records every sidebar item's place every 50ms from the first paint on.
// Nothing may appear, disappear or move after the first paint — unless
// something really changed between the two loads, in which case the run is
// inconclusive and repeated (a live instance has agents working).
//
// Three ways of reloading: normally; with every server answer slowed down;
// with the server cut off (only the sign-in check gets through — the saved
// copy alone must paint the whole sidebar); and with one machine gone silent
// (the server reports it unreachable and passes on nothing from it) — its
// conversations may grey out, but nothing anywhere may move, appear or vanish.
// Desktop and phone sizes.
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
    // Everything in the sidebar's list, plus the footer below it.
    const SELECTOR = [
      "[data-conversation-id]",
      "[data-app-key]",
      '[data-testid="pretty-conversations-apps-header"]',
      '[data-testid^="pv-project-section-header-"]',
      '[data-testid="pretty-conversations-pinned-header"]',
      '[data-testid="pv-projects-super-header"]',
      '[data-testid="pv-flat-middle-section-header"]',
      '[data-testid="rdp-divider"]',
    ].join(",");
    const FOOTER_SELECTOR = [
      '[data-testid="pv-footer-username"]',
      '[data-testid="pv-footer-avatar-image"]',
      '[data-testid="pv-footer-initials"]',
      '[data-testid^="pv-footer-"][data-testid$="-button"]',
    ].join(",");
    // What a row shows, besides where it is: picture or letter, and its name.
    const look = (el: HTMLElement): string => {
      if (!el.hasAttribute("data-conversation-id")) return "";
      const avatar = el.querySelector('[data-testid="pcrow-avatar"]');
      const kind = avatar?.querySelector("img") ? "pic" : avatar?.querySelector('[data-testid="avatar-initial"]') ? "letter" : "none";
      const name = el.querySelector(".pv-label")?.textContent?.trim() ?? "";
      return ` ${kind} "${name}"`;
    };
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
            marks:
              (el.getAttribute("data-unread") ? " unread" : "") +
              (el.getAttribute("data-dm") ? " dm" : "") +
              (el.getAttribute("data-host-unreachable") ? " down" : "") +
              look(el),
          });
        }
        if (items.length > 0) {
          for (const el of document.querySelectorAll<HTMLElement>(FOOTER_SELECTOR)) {
            const r = el.getBoundingClientRect();
            items.push({
              key: `footer:${el.getAttribute("data-testid")}`,
              top: Math.round(r.top),
              left: Math.round(r.left),
              marks: el.getAttribute("data-testid") === "pv-footer-username" ? ` "${el.textContent?.trim()}"` : "",
            });
          }
        }
      }
      w.__sidebarSamples.push({ t: Math.round(performance.now() - t0), items });
      if (performance.now() - t0 < watchMs) setTimeout(tick, 50);
    };
    tick();
  }, WATCH_MS + 8_000);
}

/** One machine's rows are allowed to grey out (its down mark is left out). */
const layoutOf = (s: Sample, downHost?: string) =>
  s.items
    .map((i) => {
      const onDownHost = downHost !== undefined && i.key.startsWith(`fleet::${downHost}::`);
      return `${i.key}@${i.top},${i.left}${onDownHost ? i.marks.replace(" down", "") : i.marks}`;
    })
    .sort()
    .join("\n");

async function samples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => (window as unknown as { __sidebarSamples: Sample[] }).__sidebarSamples);
}

/** The sidebar once the page has been sitting still. */
async function settledSample(page: Page): Promise<Sample> {
  await page.waitForTimeout(SETTLE_MS);
  const all = await samples(page);
  return all[all.length - 1];
}

type Mode = "normal" | "slow" | "offline" | "one-machine-down";

/** The server reports `hostId` unreachable and passes on nothing from it. */
async function silenceMachine(page: Page, hostId: string) {
  const sameHost = (h: unknown) => String(h) === hostId;
  await page.route(/\/sessions\/list/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Array<{ hostId?: unknown }>;
    await route.fulfill({
      response: res,
      json: body.filter((s) => !sameHost(s.hostId)),
      headers: { ...res.headers(), "x-skynet-unreachable-hosts": hostId },
    });
  });
  await page.route(/\/identities(\?|$)/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Array<{ hostId?: unknown }>;
    await route.fulfill({ response: res, json: Array.isArray(body) ? body.filter((i) => !sameHost(i.hostId)) : body });
  });
  // Its pictures still come from the browser's cache in real life; leave them.
  await page.route(new RegExp(`[?&]hostId=${hostId}(&|$)`), (route) =>
    new URL(route.request().url()).pathname.endsWith("/avatar") ? route.fallback() : route.abort(),
  );
  await page.routeWebSocket(/fleet-status/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      let f: Record<string, any>;
      try {
        f = JSON.parse(String(m));
      } catch {
        return ws.send(m);
      }
      if (f.type === "snapshot") f.states = f.states.filter((st: any) => !sameHost(st.hostId));
      else if (f.type === "update" && sameHost(f.state?.hostId)) return;
      else if ((f.type === "gone" || f.type === "project-list-changed" || f.type === "app-gone") && sameHost(f.hostId)) return;
      else if (f.type === "app-update" && sameHost(f.app?.hostId)) return;
      else if (f.type === "app-snapshot") {
        f.apps = f.apps.filter((a: any) => !sameHost(a.hostId));
        if (Array.isArray(f.reportedHostIds)) f.reportedHostIds = f.reportedHostIds.filter((h: unknown) => !sameHost(h));
      }
      ws.send(JSON.stringify(f));
    });
  });
}

/** A machine with conversations in the sidebar, when there are at least two. */
function machineToSilence(layout: string): string | null {
  const hosts = new Set([...layout.matchAll(/^fleet::(\d+)::/gm)].map((m) => m[1]));
  return hosts.size >= 2 ? [...hosts][0] : null;
}

async function cutOff(page: Page, mode: Mode, before: string) {
  if (mode === "normal") return;
  if (mode === "one-machine-down") return silenceMachine(page, machineToSilence(before)!);
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

/**
 * Reload and report what moved after the first paint — or, as `changed`, what
 * really changed between the two loads (the attempt is then inconclusive).
 */
async function reloadAndCompare(
  page: Page,
  mode: Mode,
  beforeSample: Sample,
): Promise<{ problems: string[] } | { changed: string; silencedMoved: boolean }> {
  const down = mode === "one-machine-down" ? machineToSilence(layoutOf(beforeSample)) ?? undefined : undefined;
  const before = layoutOf(beforeSample, down);
  await cutOff(page, mode, layoutOf(beforeSample));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(WATCH_MS);
  const all = (await samples(page)).filter((s) => s.items.length > 0);
  expect(all.length, "the sidebar painted").toBeGreaterThan(0);
  const first = layoutOf(all[0], down);
  const last = layoutOf(all[all.length - 1], down);
  // Cut off from the server, nothing can change; otherwise a real change may land.
  if (mode !== "offline" && last !== before) {
    const lastSet = new Set(last.split("\n"));
    const silencedMoved =
      down !== undefined &&
      before.split("\n").some((l) => l.startsWith(`fleet::${down}::`) && !lastSet.has(l));
    return { changed: diff(before, last), silencedMoved };
  }
  const target = before;
  const problems: string[] = [];
  if (first !== target) problems.push(`first paint differs from last time:\n${diff(first, target)}`);
  for (const s of all) {
    const l = layoutOf(s, down);
    if (l !== target) {
      problems.push(`at +${s.t - all[0].t}ms:\n${diff(l, target)}`);
      break;
    }
  }
  return { problems };
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

    for (const mode of ["normal", "slow", "offline", "one-machine-down"] as const) {
      test(`${mode} reload`, async ({ page, context, baseURL }) => {
        await serveLocalDist(context, baseURL!);
        await installSampler(page);
        await loginViaUI(page, readCreds());
        let problems: string[] | null = null;
        let changed = "";
        // The silent machine's own rows moving on every attempt is the failure
        // this mode looks for, not a real change elsewhere.
        let silencedMovedEveryTime = true;
        for (let attempt = 0; attempt < ATTEMPTS && problems === null; attempt++) {
          await page.unrouteAll({ behavior: "ignoreErrors" });
          await page.routeWebSocket(/.*/, (ws) => ws.connectToServer());
          await page.reload({ waitUntil: "domcontentloaded" });
          const before = await settledSample(page);
          if (mode === "one-machine-down" && machineToSilence(layoutOf(before)) === null) {
            const keys = before.items.map((i) => i.key);
            test.skip(true, `needs conversations on at least two machines (saw ${keys.length} items: ${keys.slice(0, 5).join(", ")})`);
          }
          const outcome = await reloadAndCompare(page, mode, before);
          if ("problems" in outcome) problems = outcome.problems;
          else {
            changed = outcome.changed;
            silencedMovedEveryTime &&= outcome.silencedMoved;
          }
        }
        if (problems === null && mode === "one-machine-down" && silencedMovedEveryTime) {
          problems = [`the silent machine's conversations moved on every attempt:\n${changed}`];
        }
        test.skip(problems === null, `something really changed on every attempt; last time:\n${changed}`);
        expect(problems, (problems ?? []).join("\n")).toEqual([]);
      });
    }
  });
}
