/**
 * agent-services/machine-credentials/store.ts — each machine's credential
 * for calling agent services directly.
 *
 * One credential per machine (hosts.machine_id): every login on the machine
 * holds the same one. It says only which machine is asking; each entry point
 * decides what a machine may do. The backend makes it, writes it onto the
 * machine (delivery.ts) and replaces it daily; the one it replaced keeps
 * working for PREVIOUS_GRACE_MS so calls in flight finish. Revoking cuts the
 * machine off until an admin issues a new one; nothing reissues it on its
 * own. A machine that stops running agents loses its row, unless it's
 * revoked: the revoke stays in force if it's ever set up again.
 *
 * The value is kept as FieldCrypto ciphertext under the system key, so the
 * backend can write it to a login that missed the last delivery; requests
 * are checked against its SHA-256. No route ever returns a value.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { agentServiceMachineCredentials } from "../../database/db/schema.js";
import { FieldCrypto } from "../../utils/field-crypto.js";
import { SystemCrypto } from "../../utils/system-crypto.js";
import { DatabaseSaveTrigger } from "../../utils/database-save-trigger.js";
import { databaseLogger } from "../../utils/logger.js";

/** How long a credential is used before the backend replaces it. */
export const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long the replaced credential keeps working. */
export const PREVIOUS_GRACE_MS = 10 * 60 * 1000;

const TOKEN_PREFIX = "tsc_";
const table = agentServiceMachineCredentials;

const recordIdFor = (machineId: string) => `agent-service-machine:${machineId}`;
const FIELD = "token";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

async function persist(reason: string, force = false): Promise<void> {
  try {
    if (force) await DatabaseSaveTrigger.forceSave(reason);
    else await DatabaseSaveTrigger.triggerSave(reason);
  } catch (err) {
    databaseLogger.warn("machine credential save failed (non-fatal)", {
      operation: "agent_service_machine_credential_save_failed",
      reason,
      error: err,
    });
  }
}

async function encrypt(machineId: string, token: string): Promise<string> {
  const key = await SystemCrypto.getInstance().getEncryptionKey();
  return FieldCrypto.encryptField(token, key, recordIdFor(machineId), FIELD);
}

async function decrypt(machineId: string, stored: string): Promise<string> {
  const embedded = (JSON.parse(stored) as { recordId?: string }).recordId;
  if (embedded !== recordIdFor(machineId)) {
    throw new Error(`stored credential does not belong to machine ${machineId}`);
  }
  const key = await SystemCrypto.getInstance().getEncryptionKey();
  return FieldCrypto.decryptField(stored, key, recordIdFor(machineId), FIELD);
}

type Row = typeof table.$inferSelect;

async function readRow(machineId: string): Promise<Row | null> {
  const rows = await getDb().select().from(table).where(eq(table.machineId, machineId)).limit(1);
  return rows[0] ?? null;
}

/** A fresh credential's columns; `previous` (if any) becomes the one kept for the grace period. */
async function freshValues(machineId: string, nowMs: number, previous: Row | null) {
  const token = newToken();
  return {
    token,
    values: {
      token: await encrypt(machineId, token),
      tokenHash: hashToken(token),
      issuedAt: new Date(nowMs).toISOString(),
      previousHash: previous?.tokenHash ?? null,
      previousValidUntil: previous?.tokenHash ? new Date(nowMs + PREVIOUS_GRACE_MS).toISOString() : null,
    },
  };
}

// Forced saves: a credential written to the machine but lost from disk would
// lock it out after the next restart; a revoke lost from disk would undo it.
const issuedSave = () => persist("agent_service_machine_credential_issued", true);

export type CurrentCredential = { kind: "active"; token: string } | { kind: "revoked" };

/**
 * The credential the machine should hold now, issuing it the first time and
 * replacing it once it's ROTATE_AFTER_MS old. Revoked machines get none.
 *
 * Automatic writes never touch a revoked row: the first issue only inserts
 * when there's no row, and a replacement only lands on the exact unrevoked
 * row it read. If either loses a race (an admin revoked meanwhile), the row
 * is read again. Only issueNewMachineCredential lifts a revoke.
 */
export async function currentCredential(machineId: string, nowMs: number = Date.now()): Promise<CurrentCredential> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await readRow(machineId);
    if (row?.revokedAt) return { kind: "revoked" };
    if (!row) {
      const { token, values } = await freshValues(machineId, nowMs, null);
      const inserted = await getDb()
        .insert(table)
        .values({ machineId, ...values, revokedAt: null, revokedBy: null })
        .onConflictDoNothing()
        .returning({ machineId: table.machineId });
      if (inserted.length === 0) continue;
      await issuedSave();
      return { kind: "active", token };
    }
    if (row.token && row.issuedAt && nowMs - Date.parse(row.issuedAt) < ROTATE_AFTER_MS) {
      return { kind: "active", token: await decrypt(machineId, row.token) };
    }
    const { token, values } = await freshValues(machineId, nowMs, row);
    const updated = await getDb()
      .update(table)
      .set(values)
      .where(
        and(
          eq(table.machineId, machineId),
          isNull(table.revokedAt),
          row.tokenHash === null ? isNull(table.tokenHash) : eq(table.tokenHash, row.tokenHash),
        ),
      )
      .returning({ machineId: table.machineId });
    if (updated.length === 0) continue;
    await issuedSave();
    databaseLogger.info("machine credential replaced", {
      operation: "agent_service_machine_credential_rotated",
      machineId,
    });
    return { kind: "active", token };
  }
  throw new Error(`machine ${machineId}'s credential kept changing underneath; try again`);
}

export type MachineIdentity =
  | { ok: true; machineId: string }
  | { ok: false; reason: "unknown" | "revoked" };

/** Which machine a presented credential belongs to. */
export async function identifyMachine(token: string, nowMs: number = Date.now()): Promise<MachineIdentity> {
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: "unknown" };
  const h = hashToken(token);
  const rows = await getDb()
    .select()
    .from(table)
    .where(or(eq(table.tokenHash, h), eq(table.previousHash, h)))
    .limit(2);
  for (const row of rows) {
    if (row.revokedAt) return { ok: false, reason: "revoked" };
    if (row.tokenHash === h) return { ok: true, machineId: row.machineId };
    if (row.previousHash === h && row.previousValidUntil && nowMs < Date.parse(row.previousValidUntil)) {
      return { ok: true, machineId: row.machineId };
    }
  }
  return { ok: false, reason: "unknown" };
}

/**
 * Cut the machine off until an admin issues a new credential. The hashes
 * stay, so a machine holding either its current or its previous credential
 * is told it was revoked rather than just refused; the value itself goes.
 */
export async function revokeMachineCredential(machineId: string, by: string, nowMs: number = Date.now()): Promise<void> {
  const revoked = { token: null, revokedAt: new Date(nowMs).toISOString(), revokedBy: by };
  await getDb()
    .insert(table)
    .values({ machineId, tokenHash: null, issuedAt: null, previousHash: null, previousValidUntil: null, ...revoked })
    .onConflictDoUpdate({ target: table.machineId, set: revoked });
  await persist("agent_service_machine_credential_revoked", true);
}

/** Replace a revoked (or any) credential with a fresh one, lifting a revoke. */
export async function issueNewMachineCredential(machineId: string, nowMs: number = Date.now()): Promise<void> {
  const { values } = await freshValues(machineId, nowMs, null);
  const set = { ...values, revokedAt: null, revokedBy: null };
  await getDb()
    .insert(table)
    .values({ machineId, ...set })
    .onConflictDoUpdate({ target: table.machineId, set });
  await issuedSave();
}

export interface MachineCredentialStatus {
  machineId: string;
  state: "active" | "revoked";
  issuedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** Status per machine that has a row; never carries a value. */
export async function listMachineCredentialStatus(): Promise<MachineCredentialStatus[]> {
  const rows = await getDb().select().from(table);
  return rows.map((r) => ({
    machineId: r.machineId,
    state: r.revokedAt ? "revoked" : "active",
    issuedAt: r.issuedAt,
    revokedAt: r.revokedAt,
    revokedBy: r.revokedBy,
  }));
}

/**
 * Drop the credentials of machines that no longer run agents. Returns how
 * many went. A revoked machine's row is never dropped (it would come back
 * with a fresh credential if set up again), and an empty list drops nothing:
 * it's far likelier to be a failed read than an instance with no machines.
 */
export async function forgetOtherMachines(machineIds: readonly string[]): Promise<number> {
  if (machineIds.length === 0) return 0;
  const removed = await getDb()
    .delete(table)
    .where(and(notInArray(table.machineId, [...machineIds]), isNull(table.revokedAt)))
    .returning({ machineId: table.machineId });
  if (removed.length > 0) {
    databaseLogger.info("machine credentials removed for machines that no longer run agents", {
      operation: "agent_service_machine_credentials_forgotten",
      machineIds: removed.map((r) => r.machineId),
    });
    await persist("agent_service_machine_credentials_forgotten");
  }
  return removed.length;
}
