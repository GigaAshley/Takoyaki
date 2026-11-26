/**
 * agent-services/admin/key-store.ts — where services' instance keys live.
 *
 * Every read and write goes through the current key store, so where keys
 * are kept (the database, or AWS Parameter Store: parameter-store.ts) can
 * change without the engine, the routes or any service knowing. The store
 * is the instance's choice, made in the server settings (choose-store.ts).
 *
 * The database store keeps FieldCrypto ciphertext under the system
 * ENCRYPTION_KEY (like per-user secrets), so the backend can read a key at
 * 3am with nobody signed in. The HKDF context binds each value to its
 * (service, name), so a value copied to another row will not decrypt.
 *
 * Write-only by design: nothing here is reachable from a route that
 * returns a value. Routes only see `status`.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { agentServiceKeys } from "../../database/db/schema.js";
import { FieldCrypto } from "../../utils/field-crypto.js";
import { SystemCrypto } from "../../utils/system-crypto.js";
import { persist } from "./persist.js";
// Circular (choose-store builds on this file); used only at call time.
import { chooseKeyStore } from "./choose-store.js";

export interface KeyStatus {
  name: string;
  /** Null when the store can't tell right now (AWS unreachable). */
  isSet: boolean | null;
  updatedAt: string | null;
}

/** What admins are told about where keys live. */
export interface KeyStoreInfo {
  kind: "database" | "parameter_store";
  /** e.g. "the database", "AWS Parameter Store under /takoyaki/t1000". */
  label: string;
  /** Set when the store can't be used at all (half-configured). */
  problem: string | null;
  /** ISO time AWS stopped answering; last-read values are in use meanwhile. */
  unreachableSince: string | null;
}

/**
 * A change the store's backend refused (permissions). The message is meant
 * for an admin: what was refused and what to fix.
 */
export class KeyStoreRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyStoreRefusedError";
  }
}

export interface InstanceKeyStore {
  info(): KeyStoreInfo;
  get(service: string, name: string): Promise<string | null>;
  set(service: string, name: string, value: string, updatedBy: string | null): Promise<void>;
  /** True if a value was removed. */
  remove(service: string, name: string): Promise<boolean>;
  /** Whether each of a service's keys is set, without values. Never throws for reachability. */
  status(service: string, names: readonly string[]): Promise<KeyStatus[]>;
}

const recordIdFor = (service: string) => `agent-service-key:${service}`;

const byKey = (service: string, name: string) =>
  and(eq(agentServiceKeys.service, service), eq(agentServiceKeys.name, name));

export const databaseKeyStore: InstanceKeyStore = {
  info: () => ({ kind: "database", label: "the database", problem: null, unreachableSince: null }),

  async get(service, name) {
    const rows = await getDb()
      .select({ value: agentServiceKeys.value })
      .from(agentServiceKeys)
      .where(byKey(service, name))
      .limit(1);
    const stored = rows[0]?.value;
    if (!stored) return null;
    const recordId = recordIdFor(service);
    // FieldCrypto derives the key from the recordId stored inside the blob;
    // check it matches this row so a blob moved between rows is refused.
    const embedded = (JSON.parse(stored) as { recordId?: string }).recordId;
    if (embedded !== recordId) {
      throw new Error(`stored key ${service}/${name} does not belong to this service`);
    }
    const key = await SystemCrypto.getInstance().getEncryptionKey();
    return FieldCrypto.decryptField(stored, key, recordId, name);
  },

  async set(service, name, value, updatedBy) {
    const key = await SystemCrypto.getInstance().getEncryptionKey();
    const ciphertext = FieldCrypto.encryptField(value, key, recordIdFor(service), name);
    const updatedAt = new Date().toISOString();
    await getDb()
      .insert(agentServiceKeys)
      .values({ service, name, value: ciphertext, updatedAt, updatedBy })
      .onConflictDoUpdate({
        target: [agentServiceKeys.service, agentServiceKeys.name],
        set: { value: ciphertext, updatedAt, updatedBy },
      });
    await persist("agent_service_key_set");
  },

  async remove(service, name) {
    const deleted = await getDb()
      .delete(agentServiceKeys)
      .where(byKey(service, name))
      .returning({ name: agentServiceKeys.name });
    if (deleted.length > 0) await persist("agent_service_key_remove");
    return deleted.length > 0;
  },

  async status(service, names) {
    const rows = await getDb()
      .select({ name: agentServiceKeys.name, updatedAt: agentServiceKeys.updatedAt })
      .from(agentServiceKeys)
      .where(eq(agentServiceKeys.service, service));
    const byName = new Map(rows.map((r) => [r.name, r.updatedAt]));
    return names.map((name) => ({ name, isSet: byName.has(name), updatedAt: byName.get(name) ?? null }));
  },
};

let current: InstanceKeyStore | null = null;

/**
 * The store keys are read from and written to. Chosen from the server
 * settings on first use, so nothing (the admin routes serve before the
 * engine boots) can ever reach the database on an instance that chose
 * Parameter Store.
 */
export function getKeyStore(): InstanceKeyStore {
  current ??= chooseKeyStore();
  return current;
}

/** Override the chosen store (tests); null chooses again on next use. */
export function setKeyStore(store: InstanceKeyStore | null): void {
  current = store;
}
