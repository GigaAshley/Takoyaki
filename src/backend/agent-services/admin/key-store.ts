/**
 * agent-services/admin/key-store.ts — where services' instance keys live.
 *
 * Every read and write goes through the current key store, so where keys
 * are kept can change (the database today; AWS Secrets Manager is the next
 * option) without the engine, the routes or any service knowing.
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

export interface KeyStatus {
  name: string;
  updatedAt: string;
}

export interface InstanceKeyStore {
  /** Shown to admins, e.g. "the database". */
  readonly kind: string;
  /** False where the store can only be read (keys are changed elsewhere). */
  readonly writable: boolean;
  get(service: string, name: string): Promise<string | null>;
  set(service: string, name: string, value: string, updatedBy: string | null): Promise<void>;
  /** True if a value was removed. */
  remove(service: string, name: string): Promise<boolean>;
  /** Which of a service's keys are set, without values. */
  status(service: string): Promise<KeyStatus[]>;
}

const recordIdFor = (service: string) => `agent-service-key:${service}`;

const byKey = (service: string, name: string) =>
  and(eq(agentServiceKeys.service, service), eq(agentServiceKeys.name, name));

export const databaseKeyStore: InstanceKeyStore = {
  kind: "the database",
  writable: true,

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

  async status(service) {
    return getDb()
      .select({ name: agentServiceKeys.name, updatedAt: agentServiceKeys.updatedAt })
      .from(agentServiceKeys)
      .where(eq(agentServiceKeys.service, service));
  },
};

let current: InstanceKeyStore = databaseKeyStore;

/** The store keys are read from and written to. */
export function getKeyStore(): InstanceKeyStore {
  return current;
}

/** Pick where keys live (at boot, from the instance's configuration). */
export function setKeyStore(store: InstanceKeyStore): void {
  current = store;
}
