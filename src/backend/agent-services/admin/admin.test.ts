/**
 * Admin → Services against a real in-memory SQLite and the real FieldCrypto:
 * the stores, the one-time upgrade, and the routes an admin's panel drives.
 * Only the system key, the save trigger and the service list are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";

let sqlite: Database.Database;
let drizzleInstance: ReturnType<typeof drizzle>;
const systemKey = crypto.randomBytes(32);

vi.mock("../../database/db/index.js", () => ({ getDb: () => drizzleInstance }));
vi.mock("../../utils/system-crypto.js", () => ({
  SystemCrypto: { getInstance: () => ({ getEncryptionKey: async () => systemKey }) },
}));
vi.mock("../../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: { triggerSave: vi.fn(async () => {}), forceSave: vi.fn(async () => {}) },
}));
vi.mock("../../utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { databaseLogger: stub, systemLogger: stub, authLogger: stub, sshLogger: stub };
});
vi.mock("../../distributor/substrate-orchestrator-singleton.js", () => ({
  getSubstrateOrchestrator: () => null,
}));
// The real services are tested in their folders; these tests use stand-ins
// shaped like them.
vi.mock("../registry.js", () => ({ AGENT_SERVICES: [] }));
// The Bedrock provider pulls in the AWS SDK client at import time.
vi.mock("../../voice/nova-sonic-adapter.js", () => ({ transcribeNovaSonic: vi.fn() }));

import { systemLogger } from "../../utils/logger.js";
import { defineService, ok, type ServiceDefinition } from "../engine/types.js";
import { databaseKeyStore } from "./key-store.js";
import { effectiveSettings, setSetting } from "./settings-store.js";
import { __resetGrantCache, enabledServices, isEnabled, setEnabled } from "./grants.js";
import { USAGE_RETENTION_MS, recordUsage, serviceHealth, usageSummary } from "./usage.js";
import { importFromEnvironment, leftoverServiceKeys, runServicesUpgrade } from "./upgrade.js";
import { defaultServicesRouteDeps, registerServicesAdminRoutes } from "./routes.js";
import { setReachabilitySource } from "./reachability.js";
import { STT_SECRETS, STT_SETTINGS, loadSttEnv } from "../services/stt/setup.js";

const DDL = `
  CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE ssh_data (
    id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, name TEXT,
    ip TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL DEFAULT '',
    runs_fleet_substrate INTEGER NOT NULL DEFAULT 0, machine_id INTEGER
  );
  CREATE TABLE agent_service_user_secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL, service TEXT NOT NULL, name TEXT NOT NULL,
    value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT,
    UNIQUE (user_id, service, name)
  );
  CREATE TABLE agent_service_keys (
    service TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY (service, name)
  );
  CREATE TABLE agent_service_settings (
    service TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY (service, name)
  );
  CREATE TABLE agent_service_grants (
    service TEXT NOT NULL, machine_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, updated_by TEXT, PRIMARY KEY (service, machine_id)
  );
  CREATE TABLE agent_service_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, service TEXT NOT NULL,
    machine_id TEXT NOT NULL, host_id INTEGER NOT NULL, ok INTEGER NOT NULL,
    code TEXT, fault INTEGER NOT NULL DEFAULT 0
  );
`;

const machine = (id: number, name: string, machineId: number | null = id, userId = "u-admin") =>
  sqlite
    .prepare("INSERT INTO ssh_data (id, user_id, name, runs_fleet_substrate, machine_id) VALUES (?, ?, ?, 1, ?)")
    .run(id, userId, name, machineId);

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(DDL);
  drizzleInstance = drizzle(sqlite);
  __resetGrantCache();
  vi.mocked(systemLogger.info).mockClear();
});

// Stand-ins shaped like the real services.
const phone = defineService({
  name: "agent-phone",
  title: "Phone calls",
  description: "Ring a user's phone",
  input: z.strictObject({}),
  secrets: {
    TWILIO_ACCOUNT_SID: { label: "Twilio account SID", description: "Twilio console" },
    TWILIO_AUTH_TOKEN: { label: "Twilio auth token", description: "Twilio console" },
  },
  ttlMs: 1000,
  handle: async () => ok({}),
});
const images = defineService({
  name: "image-gen",
  title: "Image generation",
  description: "Make images",
  input: z.strictObject({}),
  secrets: { OPENAI_API_KEY: { label: "OpenAI API key", description: "platform.openai.com" } },
  faultCodes: ["provider_unavailable"],
  ttlMs: 1000,
  handle: async () => ok({}),
});
const stt = defineService({
  name: "stt",
  title: "Speech to text",
  description: "Transcribe audio",
  input: z.strictObject({}),
  settings: STT_SETTINGS,
  secrets: STT_SECRETS,
  ttlMs: 1000,
  handle: async () => ok({}),
});
const zoho = defineService({
  name: "zoho",
  title: "Zoho",
  description: "CRM",
  input: z.strictObject({}),
  secrets: { ZOHO_DEFAULT: { label: "Company default token", description: "Zoho", neededWhen: () => false } },
  userSecrets: { ZOHO_TOKEN: { label: "Zoho token", fallbackKey: "ZOHO_DEFAULT" } },
  ttlMs: 1000,
  handle: async () => ok({}),
});
const SERVICES: ServiceDefinition[] = [phone, images, stt, zoho];

describe("key store", () => {
  it("keeps keys encrypted, write-only, and per service", async () => {
    await databaseKeyStore.set("agent-phone", "TWILIO_AUTH_TOKEN", "s3cret", "u-admin");
    expect(await databaseKeyStore.get("agent-phone", "TWILIO_AUTH_TOKEN")).toBe("s3cret");
    expect(await databaseKeyStore.get("image-gen", "TWILIO_AUTH_TOKEN")).toBeNull();
    const raw = sqlite.prepare("SELECT value FROM agent_service_keys").get() as { value: string };
    expect(raw.value).not.toContain("s3cret");
    const status = await databaseKeyStore.status("agent-phone");
    expect(status).toEqual([{ name: "TWILIO_AUTH_TOKEN", updatedAt: expect.any(String) }]);
    expect(await databaseKeyStore.remove("agent-phone", "TWILIO_AUTH_TOKEN")).toBe(true);
    expect(await databaseKeyStore.get("agent-phone", "TWILIO_AUTH_TOKEN")).toBeNull();
  });

  it("refuses a value moved to another service's row", async () => {
    await databaseKeyStore.set("agent-phone", "KEY", "x", null);
    const { value } = sqlite.prepare("SELECT value FROM agent_service_keys").get() as { value: string };
    sqlite
      .prepare("INSERT INTO agent_service_keys (service, name, value, updated_at) VALUES ('image-gen', 'KEY', ?, 'now')")
      .run(value);
    await expect(databaseKeyStore.get("image-gen", "KEY")).rejects.toThrow(/does not belong/);
  });
});

describe("machine switches", () => {
  it("start off, and switch per service and machine", async () => {
    expect(await isEnabled("image-gen", "5")).toBe(false);
    expect(await setEnabled("image-gen", "5", true, "u-admin")).toBe(true);
    expect(await setEnabled("image-gen", "5", true, "u-admin")).toBe(false);
    expect(await isEnabled("image-gen", "5")).toBe(true);
    expect(await isEnabled("agent-phone", "5")).toBe(false);
    expect([...(await enabledServices("5"))]).toEqual(["image-gen"]);
    await setEnabled("image-gen", "5", false, "u-admin");
    expect(await isEnabled("image-gen", "5")).toBe(false);
  });
});

describe("settings", () => {
  it("apply defaults, and ignore a stored value that isn't an option", async () => {
    expect(await effectiveSettings("stt", STT_SETTINGS)).toEqual({ provider: "", backup: "none", language: "auto" });
    await setSetting("stt", "provider", "groq", null);
    await setSetting("stt", "language", "klingon", null);
    expect(await effectiveSettings("stt", STT_SETTINGS)).toEqual({ provider: "groq", backup: "none", language: "auto" });
  });
});

describe("usage records", () => {
  const rec = (ok: boolean, code: string | null, fault: boolean, machineId = "5", now?: number) =>
    recordUsage({ service: "image-gen", machineId, hostId: Number(machineId), ok, code, fault }, now);

  it("a fault makes the service failing until the next success; a bad request doesn't count", async () => {
    expect((await serviceHealth("image-gen")).failing).toBe(false);
    await rec(true, null, false);
    await rec(false, "provider_unavailable", true);
    await rec(false, "malformed", false);
    const failing = await serviceHealth("image-gen");
    expect(failing).toMatchObject({ failing: true, lastFault: { code: "provider_unavailable" } });
    await rec(true, null, false);
    expect((await serviceHealth("image-gen")).failing).toBe(false);
  });

  it("sums usage by machine and lists recent errors, never content", async () => {
    await rec(true, null, false, "5");
    await rec(false, "content_blocked", false, "5");
    await rec(true, null, false, "6");
    const summary = await usageSummary("image-gen");
    expect(summary).toMatchObject({ requests: 3, failed: 1 });
    expect(summary.byMachine.map((m) => [m.machineId, m.requests, m.failed])).toEqual([
      ["5", 2, 1],
      ["6", 1, 0],
    ]);
    expect(summary.recentErrors).toEqual([
      { at: expect.any(String), machineId: "5", code: "content_blocked", fault: false },
    ]);
    const columns = Object.keys(sqlite.prepare("SELECT * FROM agent_service_usage").get() as object);
    expect(columns.sort()).toEqual(["at", "code", "fault", "host_id", "id", "machine_id", "ok", "service"]);
  });

  it("clears records past the retention window", async () => {
    const now = Date.parse("2026-11-26T00:00:00Z");
    sqlite
      .prepare("INSERT INTO agent_service_usage (at, service, machine_id, host_id, ok) VALUES (?, 'image-gen', '5', 5, 1)")
      .run(new Date(now - USAGE_RETENTION_MS - 1000).toISOString());
    await rec(true, null, false, "5", now + 2 * 60 * 60 * 1000);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_service_usage").get() as { n: number }).n).toBe(1);
  });
});

describe("the one-time upgrade", () => {
  const ENV = {
    TWILIO_ACCOUNT_SID: "AC1",
    TWILIO_AUTH_TOKEN: "tok",
    OPENAI_API_KEY: "sk-openai",
    STT_PROVIDER: "elevenlabs",
    STT_FALLBACK_PROVIDER: "groq",
    STT_LANGUAGE: "en",
    ELEVENLABS_API_KEY: "el",
    GROQ_API_KEY: "gq",
    MISTRAL_API_KEY: "unused",
  };

  it("brings in service keys and speech to text's setup, and switches nothing on", async () => {
    machine(1, "t1000");
    expect(await importFromEnvironment(SERVICES, ENV)).toBe(true);
    expect(await databaseKeyStore.get("agent-phone", "TWILIO_AUTH_TOKEN")).toBe("tok");
    expect(await databaseKeyStore.get("image-gen", "OPENAI_API_KEY")).toBe("sk-openai");
    expect(await effectiveSettings("stt", STT_SETTINGS)).toEqual({ provider: "elevenlabs", backup: "groq", language: "en" });
    expect(await databaseKeyStore.get("stt", "ELEVENLABS_API_KEY")).toBe("el");
    expect(await databaseKeyStore.get("stt", "GROQ_API_KEY")).toBe("gq");
    // Mistral isn't picked, so its key stays behind.
    expect(await databaseKeyStore.get("stt", "MISTRAL_API_KEY")).toBeNull();
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_service_grants").get() as { n: number }).n).toBe(0);
  });

  it("runs once, and never overwrites what an admin set", async () => {
    await databaseKeyStore.set("agent-phone", "TWILIO_AUTH_TOKEN", "from-panel", "u-admin");
    await importFromEnvironment(SERVICES, ENV);
    expect(await databaseKeyStore.get("agent-phone", "TWILIO_AUTH_TOKEN")).toBe("from-panel");
    // Removed in the panel: a stale copy in the settings file never brings it back.
    await databaseKeyStore.remove("agent-phone", "TWILIO_ACCOUNT_SID");
    expect(await importFromEnvironment(SERVICES, ENV)).toBe(false);
    expect(await databaseKeyStore.get("agent-phone", "TWILIO_ACCOUNT_SID")).toBeNull();
  });

  it("an instance that already runs agents gets Amazon when voice used the default", async () => {
    machine(1, "t800");
    await importFromEnvironment(SERVICES, {});
    expect((await effectiveSettings("stt", STT_SETTINGS)).provider).toBe("bedrock");
  });

  it("a brand-new instance leaves speech to text not set up", async () => {
    await importFromEnvironment(SERVICES, {});
    expect((await effectiveSettings("stt", STT_SETTINGS)).provider).toBe("");
  });

  it("names service keys left in the settings file, but not the ones the app itself reads", async () => {
    expect(leftoverServiceKeys(SERVICES, ENV)).toEqual(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]);
    await runServicesUpgrade(SERVICES, ENV);
    expect(systemLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN"),
      expect.objectContaining({ operation: "agent_services_env_keys_ignored" }),
    );
  });
});

describe("speech to text's own setup, as phone reads it", () => {
  it("is null until a provider is picked, then carries only the service's keys", async () => {
    process.env.ELEVENLABS_API_KEY = "voice-key";
    try {
      expect(await loadSttEnv()).toBeNull();
      await setSetting("stt", "provider", "elevenlabs", null);
      expect(await loadSttEnv()).toEqual({ STT_PROVIDER: "elevenlabs" });
      await databaseKeyStore.set("stt", "ELEVENLABS_API_KEY", "service-key", null);
      expect(await loadSttEnv()).toEqual({ STT_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "service-key" });
    } finally {
      delete process.env.ELEVENLABS_API_KEY;
    }
  });
});

describe("Admin → Services routes", () => {
  let server: http.Server;
  let base: string;
  const resweep = vi.fn();

  beforeEach(async () => {
    resweep.mockClear();
    sqlite.prepare("INSERT INTO users (id, username) VALUES ('u-admin', 'ashley'), ('u-zoey', 'zoey')").run();
    machine(1, "t1000");
    machine(2, "thenasty", 2);
    machine(3, "thenasty (zoey)", 2, "u-zoey"); // same machine, Zoey's row
    machine(4, "joe-agents");
    const app = express();
    app.use(express.json());
    const router = express.Router();
    const requireAdmin: express.RequestHandler = (req, res, next) => {
      const id = req.header("x-test-user");
      if (id !== "u-admin") return res.status(403).json({ error: "Not authorized" });
      (req as unknown as { userId: string }).userId = id;
      next();
    };
    registerServicesAdminRoutes(router, requireAdmin, {
      ...defaultServicesRouteDeps,
      services: () => SERVICES,
      resweep,
    });
    app.use("/users", router);
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/users`;
  });

  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  async function call(method: string, path: string, body?: unknown, as = "u-admin") {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "x-test-user": as, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  }

  it("are admin-only", async () => {
    expect((await call("GET", "/admin/services", undefined, "u-zoey")).status).toBe(403);
    expect((await call("PUT", "/admin/services/image-gen/keys/OPENAI_API_KEY", { value: "x" }, "u-zoey")).status).toBe(403);
  });

  it("an admin sets a service up, switches machines on, and sees it ready — keys never come back", async () => {
    const list = await call("GET", "/admin/services");
    expect(list.body.keyStore).toEqual({ kind: "the database", writable: true });
    expect(list.body.services.find((s: { name: string }) => s.name === "image-gen")).toMatchObject({
      title: "Image generation",
      state: "not_set_up",
      missing: ["OpenAI API key"],
      machinesOn: 0,
      machinesTotal: 3,
    });

    expect((await call("PUT", "/admin/services/image-gen/keys/OPENAI_API_KEY", { value: "  sk-secret \n" })).body).toEqual({ ok: true });
    expect(await databaseKeyStore.get("image-gen", "OPENAI_API_KEY")).toBe("sk-secret");

    const on = await call("PUT", "/admin/services/image-gen/machines/2", { enabled: true });
    expect(on.body).toEqual({ ok: true, changed: true });
    expect(resweep).toHaveBeenCalledOnce();
    expect(await isEnabled("image-gen", "2")).toBe(true);

    const detail = await call("GET", "/admin/services/image-gen");
    expect(detail.text).not.toContain("sk-secret");
    expect(detail.body.service).toMatchObject({
      state: "ready",
      keys: [{ name: "OPENAI_API_KEY", label: "OpenAI API key", needed: true, isSet: true }],
      machines: [
        { machineId: "4", name: "joe-agents", enabled: false, unreachableSince: null },
        { machineId: "1", name: "t1000", enabled: false, unreachableSince: null },
        { machineId: "2", name: "thenasty", enabled: true, unreachableSince: null },
      ],
      personKeys: null,
    });

    const removed = await call("DELETE", "/admin/services/image-gen/keys/OPENAI_API_KEY");
    expect(removed.body).toEqual({ ok: true, removed: true });
    expect((await call("GET", "/admin/services/image-gen")).body.service.state).toBe("not_set_up");
  });

  it("shows failing from the usage records, and recent use by machine name", async () => {
    await databaseKeyStore.set("image-gen", "OPENAI_API_KEY", "k", null);
    await recordUsage({ service: "image-gen", machineId: "2", hostId: 3, ok: false, code: "provider_unavailable", fault: true });
    const detail = (await call("GET", "/admin/services/image-gen")).body.service;
    expect(detail.state).toBe("failing");
    expect(detail.lastFault).toMatchObject({ code: "provider_unavailable" });
    expect(detail.usage.byMachine).toEqual([expect.objectContaining({ name: "thenasty", requests: 1, failed: 1 })]);
    expect(detail.usage.recentErrors[0]).toMatchObject({ name: "thenasty", code: "provider_unavailable" });
  });

  it("says when a machine can't be reached, only once none of its rows answer", async () => {
    const down = new Map([["2", Date.parse("2026-11-25T10:00:00Z")]]);
    setReachabilitySource((id) => down.get(id) ?? null);
    try {
      let machines = (await call("GET", "/admin/services/image-gen")).body.service.machines;
      expect(machines.find((m: { machineId: string }) => m.machineId === "2").unreachableSince).toBeNull();
      down.set("3", Date.parse("2026-11-25T11:00:00Z"));
      machines = (await call("GET", "/admin/services/image-gen")).body.service.machines;
      expect(machines.find((m: { machineId: string }) => m.machineId === "2").unreachableSince).toBe("2026-11-25T11:00:00.000Z");
    } finally {
      setReachabilitySource(() => null);
    }
  });

  it("speech to text asks only for the keys its chosen providers need", async () => {
    let s = (await call("GET", "/admin/services/stt")).body.service;
    expect(s.state).toBe("not_set_up");
    expect(s.missing).toEqual(["Provider"]);
    expect(s.settings.map((x: { name: string; value: string }) => [x.name, x.value])).toEqual([
      ["provider", ""],
      ["backup", "none"],
      ["language", "auto"],
    ]);

    expect((await call("PUT", "/admin/services/stt/settings/provider", { value: "nope" })).status).toBe(400);
    await call("PUT", "/admin/services/stt/settings/provider", { value: "groq" });
    s = (await call("GET", "/admin/services/stt")).body.service;
    expect(s.missing).toEqual(["Groq API key"]);
    expect(s.keys.filter((k: { needed: boolean }) => k.needed).map((k: { name: string }) => k.name)).toEqual(["GROQ_API_KEY"]);

    await call("PUT", "/admin/services/stt/settings/provider", { value: "bedrock" });
    expect((await call("GET", "/admin/services/stt")).body.service.state).toBe("ready");
    // Back to unset.
    await call("PUT", "/admin/services/stt/settings/provider", { value: "" });
    expect((await call("GET", "/admin/services/stt")).body.service.state).toBe("not_set_up");
  });

  it("per-person keys are set by an admin, per person, and never shown back", async () => {
    let detail = (await call("GET", "/admin/services/zoho")).body.service;
    expect(detail.personKeys).toEqual({
      keys: [{ name: "ZOHO_TOKEN", label: "Zoho token", description: null, hasFallback: false }],
      people: [
        { userId: "u-admin", username: "ashley", set: { ZOHO_TOKEN: null } },
        { userId: "u-zoey", username: "zoey", set: { ZOHO_TOKEN: null } },
      ],
    });
    expect((await call("PUT", "/admin/services/zoho/people/u-zoey/keys/ZOHO_TOKEN", { value: "zoey-token" })).body).toEqual({ ok: true });
    expect((await call("PUT", "/admin/services/zoho/people/nobody/keys/ZOHO_TOKEN", { value: "x" })).status).toBe(404);
    expect((await call("PUT", "/admin/services/zoho/people/u-zoey/keys/NOPE", { value: "x" })).status).toBe(404);
    await call("PUT", "/admin/services/zoho/keys/ZOHO_DEFAULT", { value: "company" });
    const res = await call("GET", "/admin/services/zoho");
    expect(res.text).not.toContain("zoey-token");
    detail = res.body.service;
    expect(detail.personKeys.keys[0].hasFallback).toBe(true);
    expect(detail.personKeys.people[1].set.ZOHO_TOKEN).toEqual(expect.any(String));
    expect((await call("DELETE", "/admin/services/zoho/people/u-zoey/keys/ZOHO_TOKEN")).body).toEqual({ ok: true, removed: true });
  });

  it("refuses unknown services, keys, machines and bad values", async () => {
    expect((await call("GET", "/admin/services/nope")).status).toBe(404);
    expect((await call("PUT", "/admin/services/image-gen/keys/NOPE", { value: "x" })).status).toBe(404);
    expect((await call("PUT", "/admin/services/image-gen/keys/OPENAI_API_KEY", { value: "   " })).status).toBe(400);
    expect((await call("PUT", "/admin/services/image-gen/machines/99", { enabled: true })).status).toBe(404);
    expect((await call("PUT", "/admin/services/image-gen/machines/1", { enabled: "yes" })).status).toBe(400);
    expect(resweep).not.toHaveBeenCalled();
  });
});
