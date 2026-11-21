/**
 * Phase 103 Plan 05 Task 2 — Unit tests for serveUrlHandler.
 *
 * Verifies:
 *  - Fall-through when req.serveTarget is unset
 *  - tunnelCache.getOrCreate error mapping to error classes
 *  - proxy invocation on tunnel success
 *  - res.on('finish') success log wiring
 *  - Fail-loud on missing SKYNET_COOKIE_DOMAIN env at module load
 *  - No auth/permission re-invocation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const mocks = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  getOrCreateProxyForTarget: vi.fn(),
  getOrCreateAppDocumentProxyForTarget: vi.fn(),
  handleAppHomeScreenRequest: vi.fn(),
  sshLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  authManagerGetInstance: vi.fn(),
  permissionManagerGetInstance: vi.fn(),
}));

vi.mock("../tunnel-cache.js", () => ({
  tunnelCache: {
    getOrCreate: mocks.getOrCreate,
  },
}));

vi.mock("../proxy-factory.js", () => ({
  getOrCreateProxyForTarget: mocks.getOrCreateProxyForTarget,
  getOrCreateAppDocumentProxyForTarget: mocks.getOrCreateAppDocumentProxyForTarget,
}));

vi.mock("../app-home-screen.js", () => ({
  handleAppHomeScreenRequest: mocks.handleAppHomeScreenRequest,
}));

vi.mock("../../utils/logger.js", () => ({
  sshLogger: mocks.sshLogger,
  systemLogger: mocks.sshLogger,
  databaseLogger: mocks.sshLogger,
  apiLogger: mocks.sshLogger,
}));

vi.mock("../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: mocks.authManagerGetInstance,
  },
}));

vi.mock("../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: mocks.permissionManagerGetInstance,
  },
}));

function makeReq(serveTarget?: unknown): Request {
  return {
    headers: {},
    originalUrl: "/path",
    serveTarget,
  } as unknown as Request;
}

function makeRes(): {
  res: Response;
  finishListeners: Array<() => void>;
  statusCode: number;
} {
  const state = {
    finishListeners: [] as Array<() => void>,
    statusCode: 200,
  };
  const res = {
    on(event: string, cb: () => void) {
      if (event === "finish") state.finishListeners.push(cb);
      return this;
    },
    get statusCode() {
      return state.statusCode;
    },
    setHeader() {
      return this;
    },
    status(_code: number) {
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as Response;
  return { res, ...state };
}

describe("serveUrlHandler", () => {
  const ORIGINAL_ENV = process.env.SKYNET_COOKIE_DOMAIN;

  beforeEach(() => {
    process.env.SKYNET_COOKIE_DOMAIN = "term.example.com";
    mocks.getOrCreate.mockReset();
    mocks.getOrCreateProxyForTarget.mockReset();
    mocks.getOrCreateAppDocumentProxyForTarget.mockReset();
    mocks.handleAppHomeScreenRequest.mockReset();
    mocks.handleAppHomeScreenRequest.mockResolvedValue(false);
    mocks.sshLogger.info.mockClear();
    mocks.sshLogger.warn.mockClear();
    mocks.sshLogger.error.mockClear();
    mocks.authManagerGetInstance.mockReset();
    mocks.permissionManagerGetInstance.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.SKYNET_COOKIE_DOMAIN;
    } else {
      process.env.SKYNET_COOKIE_DOMAIN = ORIGINAL_ENV;
    }
    vi.resetModules();
  });

  it("THROWS at module load if SKYNET_COOKIE_DOMAIN is unset", async () => {
    delete process.env.SKYNET_COOKIE_DOMAIN;
    await expect(async () => {
      await import("../serve-route.js");
    }).rejects.toThrow(/SKYNET_COOKIE_DOMAIN/);
  });

  it("falls through (calls next) when req.serveTarget is unset", async () => {
    const mod = await import("../serve-route.js");
    const req = makeReq(undefined);
    const { res } = makeRes();
    const next = vi.fn();
    await mod.serveUrlHandler(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.getOrCreate).not.toHaveBeenCalled();
  });

  it("renders port_not_listening interstitial when tunnelCache throws ECONNREFUSED", async () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:3000") as Error & {
      code?: string;
    };
    err.code = "ECONNREFUSED";
    mocks.getOrCreate.mockRejectedValue(err);
    const mod = await import("../serve-route.js");
    const target = {
      hostname: "myhost",
      port: 3000,
      host: { id: 1, name: "myhost" },
    };
    const req = makeReq(target);
    const { res } = makeRes();
    const next = vi.fn();
    await mod.serveUrlHandler(req, res, next);
    expect(mocks.getOrCreateProxyForTarget).not.toHaveBeenCalled();
    // Warn log emitted with error-class classification
    const warnCall = mocks.sshLogger.warn.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("serve-url proxy"),
    );
    expect(warnCall).toBeTruthy();
    const context = (warnCall as unknown as [string, Record<string, unknown>])[1];
    expect(context.errorClass).toBe("port_not_listening");
  });

  it("classifies ETIMEDOUT as host_unreachable", async () => {
    const err = new Error("timeout") as Error & { code?: string };
    err.code = "ETIMEDOUT";
    mocks.getOrCreate.mockRejectedValue(err);
    const mod = await import("../serve-route.js");
    const target = {
      hostname: "myhost",
      port: 3000,
      host: { id: 1, name: "myhost" },
    };
    const req = makeReq(target);
    const { res } = makeRes();
    await mod.serveUrlHandler(req, res, vi.fn());
    const warnCall = mocks.sshLogger.warn.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("serve-url proxy"),
    );
    const context = (warnCall as unknown as [string, Record<string, unknown>])[1];
    expect(context.errorClass).toBe("host_unreachable");
  });

  it("classifies EHOSTUNREACH as host_unreachable", async () => {
    const err = new Error("host unreachable") as Error & { code?: string };
    err.code = "EHOSTUNREACH";
    mocks.getOrCreate.mockRejectedValue(err);
    const mod = await import("../serve-route.js");
    const target = {
      hostname: "myhost",
      port: 3000,
      host: { id: 1, name: "myhost" },
    };
    const req = makeReq(target);
    const { res } = makeRes();
    await mod.serveUrlHandler(req, res, vi.fn());
    const warnCall = mocks.sshLogger.warn.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("serve-url proxy"),
    );
    const context = (warnCall as unknown as [string, Record<string, unknown>])[1];
    expect(context.errorClass).toBe("host_unreachable");
  });

  it("classifies ssh2 auth-failure as ssh_failure", async () => {
    const err = new Error("Auth failed") as Error & { level?: string };
    err.level = "client-authentication";
    mocks.getOrCreate.mockRejectedValue(err);
    const mod = await import("../serve-route.js");
    const target = {
      hostname: "myhost",
      port: 3000,
      host: { id: 1, name: "myhost" },
    };
    const req = makeReq(target);
    const { res } = makeRes();
    await mod.serveUrlHandler(req, res, vi.fn());
    const warnCall = mocks.sshLogger.warn.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("serve-url proxy"),
    );
    const context = (warnCall as unknown as [string, Record<string, unknown>])[1];
    expect(context.errorClass).toBe("ssh_failure");
  });

  it("invokes proxy middleware on tunnel success and registers finish log", async () => {
    mocks.getOrCreate.mockResolvedValue({
      server: {},
      tunnelPort: 45000,
      sshPoolKey: "10.0.0.1:22:user",
    });
    const proxyMw = vi.fn();
    mocks.getOrCreateProxyForTarget.mockReturnValue(proxyMw);
    const mod = await import("../serve-route.js");
    const target = {
      hostname: "myhost",
      port: 3000,
      host: { id: 1, name: "myhost" },
    };
    const req = makeReq(target);
    const { res, finishListeners } = makeRes();
    const next = vi.fn();
    await mod.serveUrlHandler(req, res, next);
    expect(mocks.getOrCreateProxyForTarget).toHaveBeenCalledWith(target, 45000);
    expect(proxyMw).toHaveBeenCalledWith(req, res, next);
    // Finish listener must be registered BEFORE proxy middleware invoked
    expect(finishListeners.length).toBe(1);
    // Simulate finish → success log
    finishListeners[0]();
    const infoCall = mocks.sshLogger.info.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("serve-url proxy"),
    );
    expect(infoCall).toBeTruthy();
  });

  it("does NOT invoke AuthManager or PermissionManager", async () => {
    mocks.getOrCreate.mockResolvedValue({
      server: {},
      tunnelPort: 45000,
      sshPoolKey: "k",
    });
    mocks.getOrCreateProxyForTarget.mockReturnValue(vi.fn());
    const mod = await import("../serve-route.js");
    const target = {
      hostname: "myhost",
      port: 3000,
      host: { id: 1, name: "myhost" },
    };
    const req = makeReq(target);
    const { res } = makeRes();
    await mod.serveUrlHandler(req, res, vi.fn());
    expect(mocks.authManagerGetInstance).not.toHaveBeenCalled();
    expect(mocks.permissionManagerGetInstance).not.toHaveBeenCalled();
  });

  describe("app addresses (home-screen icon)", () => {
    const app = {
      machineId: 7,
      slug: "todo",
      title: "Todo",
      owner: null,
      project: null,
      hasIcon: true,
      iconVersion: null,
    };
    const appTarget = () => ({
      hostname: "myhost",
      port: 3000,
      host: { id: 1, name: "myhost" },
      app,
    });
    const navReq = (target: unknown, headers: Record<string, string>, method = "GET") =>
      ({ headers, method, originalUrl: "/", serveTarget: target }) as unknown as Request;

    beforeEach(() => {
      mocks.getOrCreate.mockResolvedValue({ server: {}, tunnelPort: 45000, sshPoolKey: "k" });
    });

    it("answers a reserved path itself, without opening a tunnel", async () => {
      mocks.handleAppHomeScreenRequest.mockResolvedValue(true);
      const mod = await import("../serve-route.js");
      const target = appTarget();
      const req = navReq(target, {});
      const { res } = makeRes();
      await mod.serveUrlHandler(req, res, vi.fn());
      expect(mocks.handleAppHomeScreenRequest).toHaveBeenCalledWith(req, res, app, target.host);
      expect(mocks.getOrCreate).not.toHaveBeenCalled();
    });

    it("sends a page navigation through the document proxy", async () => {
      const docMw = vi.fn();
      mocks.getOrCreateAppDocumentProxyForTarget.mockReturnValue(docMw);
      const mod = await import("../serve-route.js");
      const req = navReq(appTarget(), { "sec-fetch-dest": "document" });
      const { res } = makeRes();
      await mod.serveUrlHandler(req, res, vi.fn());
      expect(docMw).toHaveBeenCalled();
      expect(mocks.getOrCreateProxyForTarget).not.toHaveBeenCalled();
    });

    it("treats a GET accepting HTML as a navigation when Sec-Fetch-Dest is absent", async () => {
      const docMw = vi.fn();
      mocks.getOrCreateAppDocumentProxyForTarget.mockReturnValue(docMw);
      const mod = await import("../serve-route.js");
      const req = navReq(appTarget(), { accept: "text/html,application/xhtml+xml" });
      const { res } = makeRes();
      await mod.serveUrlHandler(req, res, vi.fn());
      expect(docMw).toHaveBeenCalled();
    });

    it.each([
      ["a script", { "sec-fetch-dest": "script" }, "GET"],
      ["a fetch() of HTML", { "sec-fetch-dest": "empty", accept: "text/html" }, "GET"],
      ["a form POST", { "sec-fetch-dest": "document" }, "POST"],
      ["a GET with no HTML accept", { accept: "application/json" }, "GET"],
    ])("sends %s through the plain proxy", async (_label, headers, method) => {
      const plainMw = vi.fn();
      mocks.getOrCreateProxyForTarget.mockReturnValue(plainMw);
      const mod = await import("../serve-route.js");
      const req = navReq(appTarget(), headers as Record<string, string>, method);
      const { res } = makeRes();
      await mod.serveUrlHandler(req, res, vi.fn());
      expect(plainMw).toHaveBeenCalled();
      expect(mocks.getOrCreateAppDocumentProxyForTarget).not.toHaveBeenCalled();
    });

    it("leaves a non-app address alone, page navigations included", async () => {
      const plainMw = vi.fn();
      mocks.getOrCreateProxyForTarget.mockReturnValue(plainMw);
      const mod = await import("../serve-route.js");
      const req = navReq(
        { hostname: "myhost", port: 3000, host: { id: 1, name: "myhost" } },
        { "sec-fetch-dest": "document" },
      );
      const { res } = makeRes();
      await mod.serveUrlHandler(req, res, vi.fn());
      expect(mocks.handleAppHomeScreenRequest).not.toHaveBeenCalled();
      expect(plainMw).toHaveBeenCalled();
      expect(mocks.getOrCreateAppDocumentProxyForTarget).not.toHaveBeenCalled();
    });
  });
});
