/**
 * App document proxy, end to end against a real upstream: an app's HTML
 * page gains the home-screen <head> lines (plain and gzipped); anything else
 * passes through with upstream status, headers and body intact.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import express from "express";
import { fetch } from "undici";
import { getOrCreateAppDocumentProxyForTarget } from "../proxy-factory.js";
import type { ServeTarget } from "../types.js";
import type { Host } from "../../../types/index.js";

const PAGE = "<!doctype html><html><head><title>t</title></head><body>hi</body></html>";
const OWN_ICON_PAGE = `<html><head><link rel="apple-touch-icon" href="/mine.png"></head></html>`;

let upstream: http.Server;
let proxy: http.Server;
let proxyPort: number;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/gz") {
      const body = zlib.gzipSync(PAGE);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Length": String(body.length),
        "Set-Cookie": "app=1; Path=/",
        ETag: '"abc"',
      });
      res.end(body);
      return;
    }
    if (url === "/own") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(OWN_ICON_PAGE);
      return;
    }
    if (url === "/chunked") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<html><head>");
      res.end("</head></html>");
      return;
    }
    if (url === "/endless") {
      // A page that streams forever: the head arrives, the body never ends.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<html><head><title>live</title></head><body>");
      const t = setInterval(() => res.write("<p>tick</p>"), 20);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (url === "/big") {
      // No head end within the first 64 KB.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head>" + "<!--" + "x".repeat(200_000) + "-->" + "</head><body>end</body></html>");
      return;
    }
    if (url === "/zstd") {
      const z = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "zstd" });
      res.end(z ? z(Buffer.from(PAGE)) : PAGE);
      return;
    }
    if (url === "/odd-encoding") {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "compress" });
      res.end(Buffer.from([1, 2, 3, 4]));
      return;
    }
    if (url === "/close") {
      res.writeHead(200, { "Content-Type": "text/html", Connection: "close", "Keep-Alive": "timeout=99" });
      res.end(PAGE);
      return;
    }
    if (url === "/go") {
      res.writeHead(302, { Location: "/there", "X-App": "1" });
      res.end();
      return;
    }
    if (url === "/json") {
      res.writeHead(201, { "Content-Type": "application/json", "Set-Cookie": ["a=1", "b=2"] });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const target: ServeTarget = {
    hostname: "box",
    port: 3000,
    host: { id: 1, name: "box" } as Host,
    app: {
      machineId: 1,
      slug: "todo",
      title: "To-do",
      owner: null,
      project: null,
      hasIcon: true,
      iconVersion: null,
    },
  };
  const app = express();
  app.use((req, res, next) => {
    (req as typeof req & { serveTarget?: ServeTarget }).serveTarget = target;
    getOrCreateAppDocumentProxyForTarget(target, upstreamPort)(req, res, next);
  });
  proxy = http.createServer(app);
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => upstream.close(r));
});

const get = (path: string) =>
  fetch(`http://127.0.0.1:${proxyPort}${path}`, { redirect: "manual" });

describe("app document proxy", () => {
  it("adds the home-screen lines to the app's page", async () => {
    const r = await get("/");
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).toContain('<head><link rel="apple-touch-icon" href="/__home-screen/icon-180.png">');
    expect(body).toContain('content="To-do"');
    expect(body).toContain("<title>t</title>");
  });

  it("decompresses a gzipped page and keeps the app's other headers", async () => {
    const r = await get("/gz");
    const body = await r.text();
    expect(body).toContain("/__home-screen/manifest.webmanifest");
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(r.headers.get("set-cookie")).toBe("app=1; Path=/");
    // The body changed, so the app's ETag no longer describes it.
    expect(r.headers.get("etag")).toBeNull();
  });

  it("delivers the head of a page that never finishes, without waiting for its end", async () => {
    const ctrl = new AbortController();
    const r = await fetch(`http://127.0.0.1:${proxyPort}/endless`, { signal: ctrl.signal });
    const reader = r.body!.getReader();
    let seen = "";
    const deadline = Date.now() + 2000;
    while (!seen.includes("apple-touch-icon") && Date.now() < deadline) {
      const { value } = await reader.read();
      seen += Buffer.from(value!).toString();
    }
    ctrl.abort();
    expect(seen).toContain('<head><link rel="apple-touch-icon"');
  });

  it("stops holding at 64 KB and streams the rest of a big page intact", async () => {
    const body = await (await get("/big")).text();
    expect(body.startsWith('<html><head><link rel="apple-touch-icon"')).toBe(true);
    expect(body.endsWith("<body>end</body></html>")).toBe(true);
    expect(body).toContain("x".repeat(200_000));
  });

  it.runIf(typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function")(
    "decompresses a zstd page",
    async () => {
      const r = await get("/zstd");
      expect(r.headers.get("content-encoding")).toBeNull();
      expect(await r.text()).toContain("/__home-screen/manifest.webmanifest");
    },
  );

  it("passes a page in an encoding it can't undo through untouched", async () => {
    const r = await get("/odd-encoding");
    expect(r.headers.get("content-encoding")).toBe("compress");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it("doesn't forward the app's connection-level headers", async () => {
    const r = await get("/close");
    // (Skynet's own server may add its own keep-alive; the app's never passes.)
    expect(r.headers.get("keep-alive")).not.toBe("timeout=99");
    expect(r.headers.get("connection")).not.toBe("close");
  });

  it("handles a page sent in pieces", async () => {
    const body = await (await get("/chunked")).text();
    expect(body.startsWith('<html><head><link rel="apple-touch-icon"')).toBe(true);
    expect(body.endsWith("</head></html>")).toBe(true);
  });

  it("leaves the app's own home-screen icon alone", async () => {
    const body = await (await get("/own")).text();
    expect(body).toContain('href="/mine.png"');
    expect(body).not.toContain("/__home-screen/icon-180.png");
    expect(body).toContain("/__home-screen/manifest.webmanifest");
  });

  it("passes a redirect through untouched", async () => {
    const r = await get("/go");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/there");
    expect(r.headers.get("x-app")).toBe("1");
  });

  it("passes a non-HTML response through untouched", async () => {
    const r = await get("/json");
    expect(r.status).toBe(201);
    expect(await r.text()).toBe('{"ok":true}');
    expect(r.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });
});
