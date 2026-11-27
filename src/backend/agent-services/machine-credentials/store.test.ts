/**
 * Machine credentials against a real in-memory SQLite, with the real
 * FieldCrypto. Only the system key and the save trigger are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

let sqlite: Database.Database;
let drizzleInstance: ReturnType<typeof drizzle>;
const systemKey = crypto.randomBytes(32);

vi.mock("../../database/db/index.js", () => ({ getDb: () => drizzleInstance }));
/** Runs once, the next time the system key is fetched (to land a change mid-write). */
let onNextKeyFetch: (() => Promise<void>) | null = null;
vi.mock("../../utils/system-crypto.js", () => ({
  SystemCrypto: {
    getInstance: () => ({
      getEncryptionKey: async () => {
        const hook = onNextKeyFetch;
        onNextKeyFetch = null;
        if (hook) await hook();
        return systemKey;
      },
    }),
  },
}));
const forceSave = vi.fn(async () => {});
vi.mock("../../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: { triggerSave: vi.fn(async () => {}), forceSave: (r: string) => forceSave(r) },
}));
vi.mock("../../utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { databaseLogger: stub, systemLogger: stub };
});

import {
  PREVIOUS_GRACE_MS,
  ROTATE_AFTER_MS,
  currentCredential,
  forgetOtherMachines,
  hashToken,
  identifyMachine,
  issueNewMachineCredential,
  listMachineCredentialStatus,
  revokeMachineCredential,
} from "./store.js";

const T0 = Date.parse("2026-11-27T00:00:00Z");

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE agent_service_machine_credentials (
      machine_id TEXT PRIMARY KEY, token TEXT, token_hash TEXT, issued_at TEXT,
      previous_hash TEXT, previous_valid_until TEXT, revoked_at TEXT, revoked_by TEXT
    );
  `);
  drizzleInstance = drizzle(sqlite);
  forceSave.mockClear();
});

async function activeToken(machineId: string, now = T0): Promise<string> {
  const c = await currentCredential(machineId, now);
  if (c.kind !== "active") throw new Error("expected an active credential");
  return c.token;
}

describe("machine credentials", () => {
  it("issues one the first time and gives the same one back after", async () => {
    const t = await activeToken("m1");
    expect(t).toMatch(/^tsc_[A-Za-z0-9_-]{43}$/);
    expect(await activeToken("m1", T0 + 1000)).toBe(t);
    expect(forceSave).toHaveBeenCalledOnce();
  });

  it("gives each machine its own", async () => {
    expect(await activeToken("m1")).not.toBe(await activeToken("m2"));
  });

  it("identifies the machine from its credential, and nothing else", async () => {
    const t = await activeToken("m1");
    expect(await identifyMachine(t, T0)).toEqual({ ok: true, machineId: "m1" });
    expect(await identifyMachine(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), T0)).toEqual({ ok: false, reason: "unknown" });
    expect(await identifyMachine("not-ours", T0)).toEqual({ ok: false, reason: "unknown" });
  });

  it("never stores the value in the clear", async () => {
    const t = await activeToken("m1");
    const row = sqlite.prepare("SELECT * FROM agent_service_machine_credentials").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(t);
    expect(row.token_hash).toBe(hashToken(t));
  });

  it("replaces it daily, keeping the old one working only for the grace period", async () => {
    const old = await activeToken("m1");
    const rotatedAt = T0 + ROTATE_AFTER_MS;
    const fresh = await activeToken("m1", rotatedAt);
    expect(fresh).not.toBe(old);
    expect(await identifyMachine(fresh, rotatedAt)).toEqual({ ok: true, machineId: "m1" });
    expect(await identifyMachine(old, rotatedAt + PREVIOUS_GRACE_MS - 1)).toEqual({ ok: true, machineId: "m1" });
    expect(await identifyMachine(old, rotatedAt + PREVIOUS_GRACE_MS)).toEqual({ ok: false, reason: "unknown" });
  });

  it("cuts a revoked machine off, says so, and never reissues on its own", async () => {
    const t = await activeToken("m1");
    await revokeMachineCredential("m1", "admin-1", T0 + 5);
    expect(await identifyMachine(t, T0 + 6)).toEqual({ ok: false, reason: "revoked" });
    expect(await currentCredential("m1", T0 + ROTATE_AFTER_MS * 3)).toEqual({ kind: "revoked" });
    expect(await listMachineCredentialStatus()).toEqual([
      {
        machineId: "m1",
        state: "revoked",
        issuedAt: new Date(T0).toISOString(),
        revokedAt: new Date(T0 + 5).toISOString(),
        revokedBy: "admin-1",
      },
    ]);
  });

  it("issues a new one when an admin asks, lifting the revoke; the revoked one stays dead", async () => {
    const t = await activeToken("m1");
    await revokeMachineCredential("m1", "admin-1", T0 + 1);
    await issueNewMachineCredential("m1", T0 + 2);
    const fresh = await activeToken("m1", T0 + 3);
    expect(fresh).not.toBe(t);
    expect(await identifyMachine(fresh, T0 + 3)).toEqual({ ok: true, machineId: "m1" });
    expect((await identifyMachine(t, T0 + 3)).ok).toBe(false);
    expect((await listMachineCredentialStatus())[0]).toMatchObject({ state: "active", revokedAt: null });
  });

  it("drops the credentials of machines that no longer run agents, but never a revoke", async () => {
    const gone = await activeToken("m1");
    await activeToken("m2");
    await activeToken("m3");
    await revokeMachineCredential("m3", "admin-1", T0);
    expect(await forgetOtherMachines(["m2"])).toBe(1);
    expect(await identifyMachine(gone, T0)).toEqual({ ok: false, reason: "unknown" });
    expect((await listMachineCredentialStatus()).map((s) => s.machineId).sort()).toEqual(["m2", "m3"]);
    // Set up again later, the revoked machine is still revoked.
    expect(await currentCredential("m3", T0 + 1)).toEqual({ kind: "revoked" });
  });

  it("an empty machine list (a failed read) drops nothing", async () => {
    await activeToken("m1");
    expect(await forgetOtherMachines([])).toBe(0);
    expect(await listMachineCredentialStatus()).toHaveLength(1);
  });

  it("a revoke landing while a replacement is being made wins", async () => {
    await activeToken("m1");
    // The replacement has read the row and is encrypting its new value when the admin revokes.
    onNextKeyFetch = () => revokeMachineCredential("m1", "admin-1", T0 + ROTATE_AFTER_MS);
    expect(await currentCredential("m1", T0 + ROTATE_AFTER_MS)).toEqual({ kind: "revoked" });
    expect((await listMachineCredentialStatus())[0]).toMatchObject({ state: "revoked", revokedBy: "admin-1" });
  });

  it("a first issue racing a revoke never overwrites it", async () => {
    onNextKeyFetch = () => revokeMachineCredential("m9", "admin-1", T0);
    expect(await currentCredential("m9", T0)).toEqual({ kind: "revoked" });
  });

  it("a machine still on its replaced credential is told it was revoked", async () => {
    const old = await activeToken("m1");
    await activeToken("m1", T0 + ROTATE_AFTER_MS);
    await revokeMachineCredential("m1", "admin-1", T0 + ROTATE_AFTER_MS + 1);
    expect(await identifyMachine(old, T0 + ROTATE_AFTER_MS + 2)).toEqual({ ok: false, reason: "revoked" });
  });
});
