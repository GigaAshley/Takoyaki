/**
 * Home-screen identity for apps opened standalone — the icon picture, the
 * reserved icon + manifest paths, and the <head> lines.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({
  readAppIconFile: vi.fn(),
  isLocalHostId: vi.fn(() => true),
  connectOneShot: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../claude-session/identity-artifact-reader.js", () => ({
  readAppIconFile: mocks.readAppIconFile,
  isLocalHostId: mocks.isLocalHostId,
}));
vi.mock("../../ssh/ssh-one-shot.js", () => ({ connectOneShot: mocks.connectOneShot }));
vi.mock("../../utils/logger.js", () => ({
  sshLogger: mocks.log,
  systemLogger: mocks.log,
  databaseLogger: mocks.log,
  apiLogger: mocks.log,
}));

import {
  APP_MANIFEST_PATH,
  _clearHomeScreenIconCacheForTest,
  handleAppHomeScreenRequest,
  injectAppHomeScreenTags,
  renderHomeScreenIcons,
} from "../app-home-screen.js";
import { _resetAvatarCacheForTest } from "../../database/routes/identity-avatar-cache.js";

const BLUE = { r: 49, g: 92, b: 134 };

/** 1024² transparent canvas with a rounded blue tile and a white square in it
 *  — the shape app icons are drawn in. */
async function tileIcon(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <rect x="110" y="110" width="804" height="804" rx="180" fill="rgb(${BLUE.r},${BLUE.g},${BLUE.b})"/>
    <rect x="300" y="300" width="424" height="424" fill="#fff"/></svg>`;
  return sharp(Buffer.from(svg)).webp({ lossless: true }).toBuffer();
}

/** A tile with a see-through hole cut out of it (no white paint). */
async function holedTileIcon(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <path fill-rule="evenodd" fill="rgb(${BLUE.r},${BLUE.g},${BLUE.b})"
      d="M290 110 H734 A180 180 0 0 1 914 290 V734 A180 180 0 0 1 734 914 H290 A180 180 0 0 1 110 734 V290 A180 180 0 0 1 290 110 Z M300 300 V724 H724 V300 Z"/></svg>`;
  return sharp(Buffer.from(svg)).webp({ lossless: true }).toBuffer();
}

/** Free-floating art: a small red dot with no tile around it. */
async function floatingIcon(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <circle cx="512" cy="512" r="200" fill="#d00"/></svg>`;
  return sharp(Buffer.from(svg)).webp({ lossless: true }).toBuffer();
}

async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2], channels: info.channels };
}

const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  Math.abs(a.r - b.r) <= 3 && Math.abs(a.g - b.g) <= 3 && Math.abs(a.b - b.b) <= 3;

describe("renderHomeScreenIcons", () => {
  it("trims the margin and fills the corners with the tile's edge colour", async () => {
    const { background, pngs } = await renderHomeScreenIcons(await tileIcon());
    expect(near(background, BLUE)).toBe(true);
    const png = pngs.get(180)!;
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([180, 180, false]);
    // Corner (was transparent margin + rounded corner) is now the tile colour.
    const corner = await pixel(png, 0, 0);
    expect(near(corner, BLUE)).toBe(true);
    // Edge midpoint is tile, not margin: the art fills the square.
    expect(near(await pixel(png, 90, 2), BLUE)).toBe(true);
    // The art itself survives.
    expect(near(await pixel(png, 90, 90), { r: 255, g: 255, b: 255 })).toBe(true);
  });

  it("keeps see-through holes inside the tile white, not the edge colour", async () => {
    const { pngs } = await renderHomeScreenIcons(await holedTileIcon());
    const png = pngs.get(180)!;
    expect(near(await pixel(png, 0, 0), BLUE)).toBe(true);
    expect(near(await pixel(png, 90, 90), { r: 255, g: 255, b: 255 })).toBe(true);
  });

  it("puts free-floating art on white, with a margin", async () => {
    const { background, pngs } = await renderHomeScreenIcons(await floatingIcon());
    expect(background).toEqual({ r: 255, g: 255, b: 255 });
    const png = pngs.get(512)!;
    expect(near(await pixel(png, 0, 0), { r: 255, g: 255, b: 255 })).toBe(true);
    expect(near(await pixel(png, 256, 256), { r: 221, g: 0, b: 0 })).toBe(true);
    // Trimmed tight, the dot would touch the top edge; with the margin it doesn't.
    expect(near(await pixel(png, 256, 20), { r: 255, g: 255, b: 255 })).toBe(true);
  });

  it("refuses an absurdly large picture instead of decoding it", async () => {
    const huge = await sharp({
      create: { width: 5000, height: 5000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .webp()
      .toBuffer();
    await expect(renderHomeScreenIcons(huge)).rejects.toThrow();
  });

  it("makes every size", async () => {
    const { pngs } = await renderHomeScreenIcons(await tileIcon());
    for (const size of [180, 192, 512] as const) {
      const meta = await sharp(pngs.get(size)!).metadata();
      expect([meta.width, meta.height]).toEqual([size, size]);
    }
  });
});

describe("injectAppHomeScreenTags", () => {
  const app = { title: 'To-do & "lists"', hasIcon: true };
  const inject = (html: string) => injectAppHomeScreenTags(Buffer.from(html), app);

  it("adds every line right after <head>, title escaped", () => {
    const { html, skipped } = inject("<!doctype html><html><head><title>x</title></head><body></body></html>");
    const out = html.toString();
    expect(skipped).toEqual([]);
    expect(out).toContain(
      '<head><link rel="apple-touch-icon" href="/__home-screen/icon-180.png">',
    );
    expect(out).toContain(
      '<meta name="apple-mobile-web-app-title" content="To-do &amp; &quot;lists&quot;">',
    );
    expect(out).toContain(
      '<link rel="manifest" href="/__home-screen/manifest.webmanifest" crossorigin="use-credentials">',
    );
    expect(out).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
    expect(out).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(out.startsWith("<!doctype html><html><head><link")).toBe(true);
  });

  it("leaves each line the app already declares", () => {
    const { html, skipped } = inject(
      `<html><head><link rel="apple-touch-icon" href="/mine.png"><link rel=manifest href="/m.json"></head></html>`,
    );
    const out = html.toString();
    expect(skipped).toEqual(["icon", "manifest"]);
    expect(out).not.toContain("/__home-screen/icon-180.png");
    expect(out).not.toContain("/__home-screen/manifest.webmanifest");
    expect(out).toContain("apple-mobile-web-app-title");
  });

  it("counts the app's own title and full-screen meta", () => {
    const { skipped } = inject(
      `<head><meta name="apple-mobile-web-app-title" content="Mine"><meta name="apple-mobile-web-app-capable" content="no"></head>`,
    );
    expect(skipped).toEqual(["title", "apple-capable"]);
  });

  it("returns the same bytes when the app declares everything", () => {
    const page = Buffer.from(
      `<head><link rel="apple-touch-icon precomposed" href="/i.png"><meta name="apple-mobile-web-app-title" content="M"><link rel="manifest" href="/m"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"></head>`,
    );
    const { html } = injectAppHomeScreenTags(page, app);
    expect(html).toBe(page);
  });

  it("adds no touch icon for an app without one", () => {
    const out = injectAppHomeScreenTags(Buffer.from("<head></head>"), { title: "x", hasIcon: false })
      .html.toString();
    expect(out).not.toContain("apple-touch-icon");
    expect(out).toContain("/__home-screen/manifest.webmanifest");
  });

  it("never re-encodes the page: non-UTF-8 bytes survive, the title is ASCII", () => {
    // windows-1252 "café" (0xE9) — not valid UTF-8.
    const page = Buffer.concat([
      Buffer.from("<html><head></head><body>caf", "latin1"),
      Buffer.from([0xe9]),
      Buffer.from("</body></html>", "latin1"),
    ]);
    const { html } = injectAppHomeScreenTags(page, { title: "Café 日記", hasIcon: true });
    expect(html.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true);
    expect(html.toString("latin1")).toContain('content="Caf&#233; &#26085;&#35352;"');
  });

  it("isn't fooled by <header>", () => {
    const out = inject("<html><body><header>x</header></body></html>").html.toString();
    expect(out.startsWith('<html><link rel="apple-touch-icon"')).toBe(true);
  });

  it("goes after the doctype, never before it, when there's no <head> or <html>", () => {
    const out = inject("<!DOCTYPE html><p>hi</p>").html.toString();
    expect(out.startsWith('<!DOCTYPE html><link rel="apple-touch-icon"')).toBe(true);
  });
});

describe("handleAppHomeScreenRequest", () => {
  const app = {
    machineId: 42,
    slug: "todo",
    title: "To-do",
    owner: null,
    project: null,
    hasIcon: true,
    iconVersion: null,
  };
  const host = { id: 42, name: "box" } as never;

  function call(path: string, method = "GET", headers: Record<string, string> = {}) {
    const state = {
      status: 0,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
    };
    const res = {
      setHeader(k: string, v: string) {
        state.headers[k.toLowerCase()] = v;
        return this;
      },
      status(c: number) {
        state.status = c;
        return this;
      },
      json(b: unknown) {
        state.body = b;
        return this;
      },
      end(b?: unknown) {
        state.body = b;
        return this;
      },
    } as unknown as Response;
    const req = { path, method, headers } as unknown as Request;
    return handleAppHomeScreenRequest(req, res, app, host).then((handled) => ({ handled, ...state }));
  }

  beforeEach(() => {
    _clearHomeScreenIconCacheForTest();
    _resetAvatarCacheForTest();
    mocks.readAppIconFile.mockReset();
    mocks.log.warn.mockClear();
    mocks.log.info.mockClear();
  });

  it("serves the icon as a PNG at the asked size", async () => {
    mocks.readAppIconFile.mockResolvedValue({ bytes: await tileIcon(), mime: "image/webp" });
    const r = await call("/__home-screen/icon-180.png");
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    const meta = await sharp(r.body as Buffer).metadata();
    expect([meta.format, meta.width]).toEqual(["png", 180]);
    expect(mocks.readAppIconFile).toHaveBeenCalledWith(null, "todo", null, null);
  });

  it("answers a repeat with the matching ETag as 304, and reuses the picture", async () => {
    mocks.readAppIconFile.mockResolvedValue({ bytes: await tileIcon(), mime: "image/webp" });
    const first = await call("/__home-screen/icon-192.png");
    const again = await call("/__home-screen/icon-192.png", "GET", {
      "if-none-match": first.headers.etag,
    });
    expect(again.status).toBe(304);
    const made = mocks.log.info.mock.calls.filter((c) => String(c[0]).includes("icon made"));
    expect(made).toHaveLength(1);
  });

  it("404s when the app has no icon", async () => {
    mocks.readAppIconFile.mockResolvedValue(null);
    const r = await call("/__home-screen/icon-180.png");
    expect([r.handled, r.status]).toEqual([true, 404]);
  });

  it("502s and logs when the icon can't be read", async () => {
    mocks.readAppIconFile.mockRejectedValue(new Error("sftp gone"));
    const r = await call("/__home-screen/icon-180.png");
    expect([r.handled, r.status]).toEqual([true, 502]);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not be made"),
      expect.objectContaining({ hostId: 42, slug: "todo", reason: "sftp gone" }),
    );
  });

  it("serves a full-screen manifest named after the app, in its icon colour", async () => {
    mocks.readAppIconFile.mockResolvedValue({ bytes: await tileIcon(), mime: "image/webp" });
    const r = await call(APP_MANIFEST_PATH);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/manifest+json");
    const m = JSON.parse(String(r.body));
    expect(m).toMatchObject({ name: "To-do", short_name: "To-do", display: "standalone", start_url: "/", scope: "/" });
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(["192x192", "512x512"]);
    expect(m.background_color).toMatch(/^#3[01]5[bc]8[56]$/);
  });

  it("still serves the manifest, without icons, when the app has none", async () => {
    mocks.readAppIconFile.mockResolvedValue(null);
    const m = JSON.parse(String((await call(APP_MANIFEST_PATH)).body));
    expect(m.icons).toEqual([]);
    expect(m.background_color).toBe("#ffffff");
  });

  it.each([
    ["any other path", "/index.html", "GET"],
    ["an unsupported size", "/__home-screen/icon-64.png", "GET"],
    ["a POST to a reserved path", "/__home-screen/icon-180.png", "POST"],
  ])("leaves %s to the app", async (_l, path, method) => {
    const r = await call(path, method);
    expect(r.handled).toBe(false);
    expect(mocks.readAppIconFile).not.toHaveBeenCalled();
  });
});
