/**
 * Home-screen identity for apps opened standalone.
 *
 * "Open standalone" lands on the app's own serve address. Without help, iOS
 * Add to Home Screen falls back to a screenshot (the app's page names no
 * touch icon), and the shortcut opens as a Safari tab. On serve addresses
 * that belong to an app, Skynet adds:
 *
 *   - `/__home-screen/icon-<size>.png` — the app's icon.webp as a square PNG:
 *     transparent margin trimmed, leftover corners filled with the colour
 *     along the art's own edge (white when the art has no solid edge), so
 *     the home-screen icon is full-bleed like a native app's.
 *   - `/__home-screen/manifest.webmanifest` — name, icons, `display: standalone`.
 *   - A few `<head>` lines on document responses pointing at the two above
 *     and naming the shortcut. Each is skipped when the app declares its own.
 *
 * Non-app serve addresses never reach this module (dispatch attaches
 * `serveTarget.app` only when the port belongs to a registered app).
 */

import type { Request, Response } from "express";
import sharp from "sharp";
import type { Host } from "../../types/index.js";
import {
  isLocalHostId,
  readAppIconFile,
} from "../claude-session/identity-artifact-reader.js";
import { getCachedAvatar } from "../database/routes/identity-avatar-cache.js";
import { connectOneShot } from "../ssh/ssh-one-shot.js";
import { getHostSemaphore } from "../ssh/host-semaphore-registry.js";
import { sshLogger } from "../utils/logger.js";
import type { ServeAppInfo } from "./types.js";

export const APP_ICON_PATH_PREFIX = "/__home-screen/icon-";
export const APP_MANIFEST_PATH = "/__home-screen/manifest.webmanifest";
/** 180 = iOS touch icon; 192 + 512 = what installable-app checks want. */
export const APP_ICON_SIZES = [180, 192, 512] as const;
type IconSize = (typeof APP_ICON_SIZES)[number];

const WHITE = { r: 255, g: 255, b: 255 };
/** Alpha above this counts as "art" when trimming the transparent margin. */
const TRIM_ALPHA = 16;
/** Alpha at or above this counts as a solid edge pixel. */
const SOLID_ALPHA = 200;
/** A solid edge needs at least half the sampled edge ring solid. A rounded
 *  tile (corner radius up to ~30%) scores 60-75%; a disc scores under 30%. */
const SOLID_EDGE_SHARE = 0.5;

export type Rgb = { r: number; g: number; b: number };
export type HomeScreenIcon = { png: Buffer; background: Rgb };

/* ------------------------------------------------------------------------ */
/*  Picture                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The colour along the art's outer edge: the mean of the solid pixels on a
 * ring just inside the art's bounds (inset 2% to skip anti-aliasing), or null
 * when too few of them are solid — free-floating art with no tile.
 */
function edgeColour(
  data: Buffer,
  width: number,
  box: { left: number; top: number; w: number; h: number },
): Rgb | null {
  const inset = Math.max(1, Math.round(Math.min(box.w, box.h) * 0.02));
  const x0 = box.left + inset;
  const y0 = box.top + inset;
  const x1 = box.left + box.w - 1 - inset;
  const y1 = box.top + box.h - 1 - inset;
  if (x1 <= x0 || y1 <= y0) return null;
  let sampled = 0;
  let solid = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  const visit = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    sampled++;
    if (data[i + 3] >= SOLID_ALPHA) {
      solid++;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
  };
  for (let x = x0; x <= x1; x++) {
    visit(x, y0);
    visit(x, y1);
  }
  for (let y = y0 + 1; y < y1; y++) {
    visit(x0, y);
    visit(x1, y);
  }
  if (sampled === 0 || solid / sampled < SOLID_EDGE_SHARE) return null;
  return {
    r: Math.round(r / solid),
    g: Math.round(g / solid),
    b: Math.round(b / solid),
  };
}

/** Icons are drawn at 1024²; anything bigger is shrunk before the pixel work,
 *  and anything absurd is refused outright. */
const MAX_SOURCE_SIDE = 1024;
const MAX_SOURCE_PIXELS = 4096 * 4096;
/** Share of the square free-floating art (no tile) spans, leaving a margin. */
const FLOATING_ART_SHARE = 0.76;
/** Below this alpha a pixel lets the outside colour show through. */
const SEE_THROUGH_ALPHA = 250;

/**
 * Square, opaque PNG of the art at each size, plus the colour behind it.
 *
 * Tile art (a solid edge): cropped to the tile so it fills the square; the
 * see-through area outside the tile (the rounded corners) takes the tile's
 * edge colour, and see-through holes inside the art are white. Free-floating
 * art: centred with a margin, on white.
 */
export async function renderHomeScreenIcons(
  source: Buffer,
): Promise<{ background: Rgb; pngs: Map<IconSize, Buffer> }> {
  const { data, info } = await sharp(source, { limitInputPixels: MAX_SOURCE_PIXELS })
    .resize(MAX_SOURCE_SIDE, MAX_SOURCE_SIDE, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Bounds of the art (alpha above the trim threshold).
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > TRIM_ALPHA) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  const empty = right < 0;
  const box = empty
    ? { left: 0, top: 0, w: width, h: height }
    : { left, top, w: right - left + 1, h: bottom - top + 1 };
  const edge = empty ? null : edgeColour(data, width, box);
  const background = edge ?? WHITE;

  // The art centred on a transparent square.
  const longest = Math.max(box.w, box.h);
  const side = edge ? longest : Math.round(longest / FLOATING_ART_SHARE);
  const offX = Math.floor((side - box.w) / 2);
  const offY = Math.floor((side - box.h) / 2);
  const art = Buffer.alloc(side * side * 4);
  for (let y = 0; y < box.h; y++) {
    const from = ((box.top + y) * width + box.left) * 4;
    data.copy(art, ((offY + y) * side + offX) * 4, from, from + box.w * 4);
  }

  // What shows through the art: the edge colour where the see-through area
  // reaches the square's border (outside the tile), white everywhere else.
  const behind = Buffer.alloc(side * side * 3, 255);
  if (edge) {
    const outside = new Uint8Array(side * side);
    const queue = new Int32Array(side * side);
    let head = 0;
    let tail = 0;
    const visit = (p: number) => {
      if (!outside[p] && art[p * 4 + 3] < SEE_THROUGH_ALPHA) {
        outside[p] = 1;
        queue[tail++] = p;
      }
    };
    for (let i = 0; i < side; i++) {
      visit(i);
      visit((side - 1) * side + i);
      visit(i * side);
      visit(i * side + side - 1);
    }
    while (head < tail) {
      const p = queue[head++];
      const x = p % side;
      if (x > 0) visit(p - 1);
      if (x < side - 1) visit(p + 1);
      if (p >= side) visit(p - side);
      if (p < side * (side - 1)) visit(p + side);
    }
    for (let p = 0; p < side * side; p++) {
      if (outside[p]) {
        behind[p * 3] = edge.r;
        behind[p * 3 + 1] = edge.g;
        behind[p * 3 + 2] = edge.b;
      }
    }
  }

  const square = await sharp(behind, { raw: { width: side, height: side, channels: 3 } })
    .composite([{ input: art, raw: { width: side, height: side, channels: 4 } }])
    .removeAlpha()
    .png()
    .toBuffer();

  const pngs = new Map<IconSize, Buffer>();
  for (const size of APP_ICON_SIZES) {
    pngs.set(size, await sharp(square).resize(size, size).removeAlpha().png().toBuffer());
  }
  return { background, pngs };
}

/* ------------------------------------------------------------------------ */
/*  Loading + cache                                                         */
/* ------------------------------------------------------------------------ */

type Rendered = { sourceEtag: string; background: Rgb; pngs: Map<IconSize, Buffer> };
const MAX_RENDERED = 64;
const rendered = new Map<string, Rendered>();
const renderInflight = new Map<string, Promise<Rendered>>();

/** Test seam. */
export function _clearHomeScreenIconCacheForTest(): void {
  rendered.clear();
  renderInflight.clear();
}

async function loadSourceIcon(
  app: ServeAppInfo,
  host: Host,
): Promise<{ bytes: Buffer; etag: string } | null> {
  // Keyed by scope too: a sidebar app and a conversation app may share a
  // slug on one box. The sweep's icon version keeps the bytes current.
  const { avatar } = await getCachedAvatar(
    app.machineId,
    `home-screen.${app.owner ?? ""}.${app.project ?? ""}.${app.slug}`,
    app.iconVersion,
    async () => {
      if (isLocalHostId(app.machineId)) {
        return readAppIconFile(null, app.slug, app.owner, app.project);
      }
      return getHostSemaphore(app.machineId).run(async () => {
        let conn: import("ssh2").Client | null = null;
        try {
          conn = await connectOneShot(host, 5_000);
          return await readAppIconFile(conn, app.slug, app.owner, app.project);
        } finally {
          if (conn) {
            try {
              conn.end();
            } catch {
              /* ignore */
            }
          }
        }
      });
    },
  );
  return avatar ? { bytes: avatar.bytes, etag: avatar.etag } : null;
}

/**
 * The app's home-screen icons, remade whenever its icon file changes (the
 * source bytes' etag is the cache check). Null when the app has no icon.
 * Throws on read / decode failure.
 */
export async function getHomeScreenIcons(
  app: ServeAppInfo,
  host: Host,
): Promise<Rendered | null> {
  const source = await loadSourceIcon(app, host);
  if (!source) return null;
  const key = `${app.machineId}:${app.owner ?? ""}:${app.project ?? ""}:${app.slug}`;
  const hit = rendered.get(key);
  if (hit && hit.sourceEtag === source.etag) {
    rendered.delete(key);
    rendered.set(key, hit);
    return hit;
  }
  const flightKey = `${key}:${source.etag}`;
  let flight = renderInflight.get(flightKey);
  if (!flight) {
    flight = renderHomeScreenIcons(source.bytes)
      .then(({ background, pngs }) => {
        const entry: Rendered = { sourceEtag: source.etag, background, pngs };
        rendered.delete(key);
        rendered.set(key, entry);
        for (const oldest of rendered.keys()) {
          if (rendered.size <= MAX_RENDERED) break;
          rendered.delete(oldest);
        }
        sshLogger.info("serve-url app home-screen: icon made", {
          operation: "serve_url_app_icon_made",
          hostId: app.machineId,
          slug: app.slug,
        });
        return entry;
      })
      .finally(() => renderInflight.delete(flightKey));
    renderInflight.set(flightKey, flight);
  }
  return flight;
}

/* ------------------------------------------------------------------------ */
/*  Reserved routes                                                         */
/* ------------------------------------------------------------------------ */

function hex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function iconSizeFromPath(path: string): IconSize | null {
  if (!path.startsWith(APP_ICON_PATH_PREFIX) || !path.endsWith(".png")) return null;
  const n = Number(path.slice(APP_ICON_PATH_PREFIX.length, -".png".length));
  return (APP_ICON_SIZES as readonly number[]).includes(n) ? (n as IconSize) : null;
}

/**
 * Answers the reserved icon / manifest paths on an app's serve address.
 * Returns false (untouched) for any other path, so the request is proxied.
 */
export async function handleAppHomeScreenRequest(
  req: Request,
  res: Response,
  app: ServeAppInfo,
  host: Host,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = req.path;
  const size = iconSizeFromPath(path);
  if (size === null && path !== APP_MANIFEST_PATH) return false;

  let icons: Rendered | null;
  try {
    icons = await getHomeScreenIcons(app, host);
  } catch (e) {
    sshLogger.warn("serve-url app home-screen: icon could not be made", {
      operation: "serve_url_app_icon_failed",
      hostId: app.machineId,
      slug: app.slug,
      reason: e instanceof Error ? e.message : String(e),
    });
    icons = null;
    if (size !== null) {
      res.status(502).json({ error: "app icon unavailable" });
      return true;
    }
  }

  if (size !== null) {
    const png = icons?.pngs.get(size);
    if (!icons || !png) {
      sshLogger.info("serve-url app home-screen: no icon on disk", {
        operation: "serve_url_app_icon_missing",
        hostId: app.machineId,
        slug: app.slug,
      });
      res.status(404).json({ error: "no icon on disk for this app" });
      return true;
    }
    const etag = `"${icons.sourceEtag.replace(/"/g, "")}-${size}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return true;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(png.byteLength));
    res.status(200).end(req.method === "HEAD" ? undefined : png);
    return true;
  }

  const background = hex(icons?.background ?? WHITE);
  const manifest = {
    name: app.title,
    short_name: app.title,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: background,
    theme_color: background,
    icons: icons
      ? APP_ICON_SIZES.filter((s) => s !== 180).map((s) => ({
          src: `${APP_ICON_PATH_PREFIX}${s}.png`,
          sizes: `${s}x${s}`,
          type: "image/png",
          purpose: "any",
        }))
      : [],
  };
  const body = JSON.stringify(manifest);
  res.setHeader("Content-Type", "application/manifest+json");
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.status(200).end(req.method === "HEAD" ? undefined : body);
  return true;
}

/* ------------------------------------------------------------------------ */
/*  <head> lines                                                            */
/* ------------------------------------------------------------------------ */

/** Attribute-safe, and ASCII-only so it reads right whatever the page's
 *  charset (the page's bytes are never re-encoded). */
function escapeAttr(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (code > 126 || code < 32) out += `&#${code};`;
    else out += ch;
  }
  return out;
}

const HAS_TOUCH_ICON = /<link\b[^>]*\brel\s*=\s*["']?[^"'>]*apple-touch-icon/i;
const HAS_MANIFEST = /<link\b[^>]*\brel\s*=\s*["']?manifest\b/i;
const metaRe = (name: string) =>
  new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*["']?${name}["'\\s>]`, "i");
const HAS_APPLE_TITLE = metaRe("apple-mobile-web-app-title");
const HAS_APPLE_CAPABLE = metaRe("apple-mobile-web-app-capable");
const HAS_CAPABLE = metaRe("mobile-web-app-capable");

/** Where the page's head ends — once seen, the app's own declarations are in. */
export const HEAD_END = /<\/head\s*>|<body[\s>]/i;

export type HomeScreenInsertion = {
  /** Byte offset in the page to insert at. */
  offset: number;
  /** The lines to insert (ASCII). Empty when the page declares them all. */
  block: Buffer;
  /** Lines left to the app because it declares its own. */
  skipped: string[];
};

/**
 * Which home-screen lines to add to a page and where, judged from the page's
 * start (its head). Works on raw bytes: matched as latin1 so every byte
 * offset is exact and nothing is re-encoded.
 */
export function planHomeScreenInsertion(
  page: Buffer,
  app: Pick<ServeAppInfo, "title" | "hasIcon">,
): HomeScreenInsertion {
  const text = page.toString("latin1");
  const lines: string[] = [];
  const skipped: string[] = [];
  const add = (present: boolean, name: string, line: string) => {
    if (present) skipped.push(name);
    else lines.push(line);
  };
  if (app.hasIcon) {
    add(
      HAS_TOUCH_ICON.test(text),
      "icon",
      `<link rel="apple-touch-icon" href="${APP_ICON_PATH_PREFIX}180.png">`,
    );
  }
  add(
    HAS_APPLE_TITLE.test(text),
    "title",
    `<meta name="apple-mobile-web-app-title" content="${escapeAttr(app.title)}">`,
  );
  add(
    HAS_MANIFEST.test(text),
    "manifest",
    // Manifest fetches omit cookies unless asked; the address needs sign-in.
    `<link rel="manifest" href="${APP_MANIFEST_PATH}" crossorigin="use-credentials">`,
  );
  add(
    HAS_APPLE_CAPABLE.test(text),
    "apple-capable",
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
  );
  add(
    HAS_CAPABLE.test(text),
    "capable",
    `<meta name="mobile-web-app-capable" content="yes">`,
  );
  const block = Buffer.from(lines.join(""), "latin1");
  // After <head>, else after <html>, else after the doctype, else first —
  // never before a doctype (that would drop the page into quirks mode).
  for (const re of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(text);
    if (m) return { offset: m.index + m[0].length, block, skipped };
  }
  return { offset: 0, block, skipped };
}

/** The whole page with the home-screen lines added (same buffer if none). */
export function injectAppHomeScreenTags(
  html: Buffer,
  app: Pick<ServeAppInfo, "title" | "hasIcon">,
): { html: Buffer; skipped: string[] } {
  const { offset, block, skipped } = planHomeScreenInsertion(html, app);
  if (block.length === 0) return { html, skipped };
  return {
    html: Buffer.concat([html.subarray(0, offset), block, html.subarray(offset)]),
    skipped,
  };
}
