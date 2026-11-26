/**
 * agent-services/admin/parameter-store.ts — service keys kept in AWS
 * Parameter Store, under a path and an encryption key the admin set up.
 *
 * The admin owns the AWS side: the path, the encryption (KMS) key, and who
 * may read them. This store only ever writes under that path, always as a
 * SecureString locked with that key (never AWS's default key, which every
 * managed machine in an account can decrypt). One parameter per key:
 *
 *   <path>/<service>/<KEY_NAME>
 *
 * Read by exact name only (services declare their keys), never by listing.
 *
 * Writing is required: a write AWS refuses is a setup mistake, reported to
 * the admin with what was refused (KeyStoreRefusedError).
 *
 * Values are cached. A change through this store updates the cache at once;
 * a change made directly in AWS is picked up within CACHE_TTL_MS. When AWS
 * can't be reached the last value read keeps being served, for as long as
 * the outage lasts; a key never read fails with the reason.
 */

import {
  DeleteParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { systemLogger } from "../../utils/logger.js";
import { KeyStoreRefusedError, type InstanceKeyStore, type KeyStatus } from "./key-store.js";

/** How long a value read from AWS is trusted before asking again. */
export const CACHE_TTL_MS = 60 * 60 * 1000;

/** While AWS is down, ask again at most this often; last-read values are served meanwhile. */
export const RETRY_WHILE_DOWN_MS = 60 * 1000;

/** A standard-tier parameter holds at most this many bytes. */
export const MAX_VALUE_BYTES = 4096;

/** GetParameters takes at most this many names per call. */
const GET_BATCH = 10;

export interface FoundParameter {
  name: string;
  value: string;
  /** SecureString for anything this store wrote. */
  type: string;
  lastModified: Date | null;
}

/** The few Parameter Store calls this store makes; swapped for a stand-in in tests. */
export interface ParameterStoreClient {
  getParameters(names: string[]): Promise<{ found: FoundParameter[]; missing: string[] }>;
  putParameter(name: string, value: string, kmsKeyId: string, description: string): Promise<void>;
  /** False when there was nothing to delete. */
  deleteParameter(name: string): Promise<boolean>;
}

export function awsParameterStoreClient(region: string): ParameterStoreClient {
  // No explicit credentials: the SDK's default chain reaches the machine
  // role through instance metadata, as voice's AWS clients do.
  // Short timeouts: a request waiting on a key shouldn't hang on AWS.
  const ssm = new SSMClient({
    region,
    // One retry at most: while AWS is down, waiting requests shouldn't stack up.
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, requestTimeout: 5_000 }),
  });
  return {
    async getParameters(names) {
      const out = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
      return {
        found: (out.Parameters ?? []).map((p) => ({
          name: p.Name ?? "",
          value: p.Value ?? "",
          type: p.Type ?? "",
          lastModified: p.LastModifiedDate ?? null,
        })),
        missing: out.InvalidParameters ?? [],
      };
    },
    async putParameter(name, value, kmsKeyId, description) {
      await ssm.send(
        new PutParameterCommand({
          Name: name,
          Value: value,
          Type: "SecureString",
          KeyId: kmsKeyId,
          Overwrite: true,
          Description: description,
        }),
      );
    },
    async deleteParameter(name) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: name }));
        return true;
      } catch (err) {
        if (errorName(err) === "ParameterNotFound") return false;
        throw err;
      }
    },
  };
}

function errorName(err: unknown): string {
  return err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How a failed AWS call reads to an admin:
 *   permission  AWS said no to this machine (role, credentials, the KMS key);
 *   invalid     AWS said no to the request itself (a name or value it won't take);
 *   unreachable anything else: network, throttling, AWS's own failures.
 */
function classify(err: unknown): "permission" | "invalid" | "unreachable" {
  const name = errorName(err);
  if (/InternalException|Throttl|Unavailable|Timeout/i.test(name)) return "unreachable";
  if (
    /AccessDenied|Unauthorized|Forbidden|UnrecognizedClient|InvalidSignature|ExpiredToken|InvalidClientTokenId/i.test(name) ||
    /^KMS|InvalidKeyId/i.test(name)
  ) {
    return "permission";
  }
  if (/ValidationException|ParameterPatternMismatch|HierarchyLevelLimitExceeded|ParameterMaxVersionLimitExceeded/i.test(name)) {
    return "invalid";
  }
  return "unreachable";
}

/** Couldn't reach AWS and there was no earlier value to fall back on. */
export class ParameterStoreUnreachableError extends Error {
  constructor(detail: string) {
    super(`couldn't reach AWS Parameter Store (${detail})`);
    this.name = "ParameterStoreUnreachableError";
  }
}

interface Cached {
  value: string | null;
  updatedAt: string | null;
  fetchedAt: number;
}

export interface ParameterStoreOptions {
  /** e.g. /takoyaki/t1000 — validated by choose-store.ts. */
  path: string;
  kmsKeyId: string;
  client: ParameterStoreClient;
  now?: () => number;
}

export function createParameterStoreKeyStore(opts: ParameterStoreOptions): InstanceKeyStore & {
  /** Test hook: forget every cached value. */
  __clearCache(): void;
} {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<void>>();
  /**
   * Bumped by every set and remove: a read that began before one never
   * writes its (older) answer over the change.
   */
  const generation = new Map<string, number>();
  const genOf = (name: string) => generation.get(name) ?? 0;
  let unreachableSince: number | null = null;
  let lastFailureAt = 0;
  /** While AWS is down, don't ask again until a minute after the last failure. */
  const holdingOff = () => unreachableSince !== null && now() - lastFailureAt < RETRY_WHILE_DOWN_MS;

  const paramName = (service: string, name: string) => `${opts.path}/${service}/${name}`;

  const reached = () => {
    if (unreachableSince === null) return;
    systemLogger.info("agent-services: AWS Parameter Store reachable again", {
      operation: "agent_services_parameter_store_back",
      downForMs: now() - unreachableSince,
    });
    unreachableSince = null;
  };
  const unreachable = (err: unknown) => {
    lastFailureAt = now();
    if (unreachableSince !== null) return;
    unreachableSince = now();
    systemLogger.warn("agent-services: can't reach AWS Parameter Store; using the keys last read", {
      operation: "agent_services_parameter_store_unreachable",
      path: opts.path,
      error: errorMessage(err),
    });
  };

  /** Read these parameters from AWS into the cache. Throws on refusal or when unreachable. */
  async function fetchIntoCache(names: string[]): Promise<void> {
    for (let i = 0; i < names.length; i += GET_BATCH) {
      const batch = names.slice(i, i + GET_BATCH);
      const started = new Map(batch.map((n) => [n, genOf(n)]));
      let result: Awaited<ReturnType<ParameterStoreClient["getParameters"]>>;
      try {
        result = await opts.client.getParameters(batch);
      } catch (err) {
        const kind = classify(err);
        if (kind !== "unreachable") {
          reached();
          throw new KeyStoreRefusedError(
            `AWS refused to read keys under ${opts.path}: ${errorMessage(err)}.` +
              (kind === "permission"
                ? ` This machine's AWS role needs ssm:GetParameters on that path and kms:Decrypt on ${opts.kmsKeyId}.`
                : ""),
          );
        }
        unreachable(err);
        throw new ParameterStoreUnreachableError(errorMessage(err));
      }
      reached();
      const at = now();
      const put = (name: string, entry: Cached) => {
        // Changed through this store while the read was out: keep the change.
        if (genOf(name) === started.get(name)) cache.set(name, entry);
      };
      const plain: string[] = [];
      for (const p of result.found) {
        if (p.type !== "SecureString") {
          // Not encrypted with the admin's key (made by hand as plain text):
          // never served.
          plain.push(p.name);
          put(p.name, { value: null, updatedAt: null, fetchedAt: at });
          continue;
        }
        put(p.name, { value: p.value, updatedAt: p.lastModified?.toISOString() ?? null, fetchedAt: at });
      }
      for (const name of result.missing) put(name, { value: null, updatedAt: null, fetchedAt: at });
      if (plain.length > 0) {
        systemLogger.warn("agent-services: ignoring Parameter Store keys that aren't SecureStrings", {
          operation: "agent_services_parameter_store_not_secure",
          names: plain,
        });
      }
    }
  }

  /** One AWS read per name at a time, however many requests want it. */
  function fetchOne(name: string): Promise<void> {
    const running = inflight.get(name);
    if (running) return running;
    const p = fetchIntoCache([name]).finally(() => inflight.delete(name));
    inflight.set(name, p);
    return p;
  }

  const fresh = (c: Cached): boolean => now() - c.fetchedAt < CACHE_TTL_MS;

  return {
    info: () => ({
      kind: "parameter_store",
      label: `AWS Parameter Store under ${opts.path}`,
      problem: null,
      unreachableSince: unreachableSince === null ? null : new Date(unreachableSince).toISOString(),
    }),

    async get(service, name) {
      const key = paramName(service, name);
      const cached = cache.get(key);
      if (cached && fresh(cached)) return cached.value;
      if (holdingOff()) {
        if (cached) return cached.value;
        throw new ParameterStoreUnreachableError(`not answering since ${new Date(unreachableSince!).toISOString()}`);
      }
      try {
        await fetchOne(key);
      } catch (err) {
        // Through an outage, keep serving what was last read.
        if (err instanceof ParameterStoreUnreachableError && cached) return cached.value;
        throw err;
      }
      return cache.get(key)?.value ?? null;
    },

    async set(service, name, value) {
      const key = paramName(service, name);
      if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
        throw new KeyStoreRefusedError(
          `That value is too long for Parameter Store, which holds at most ${MAX_VALUE_BYTES} bytes per key.`,
        );
      }
      generation.set(key, genOf(key) + 1);
      try {
        await opts.client.putParameter(key, value, opts.kmsKeyId, `Service key: ${service} ${name}`);
      } catch (err) {
        const kind = classify(err);
        if (kind !== "unreachable") {
          reached();
          throw new KeyStoreRefusedError(
            `AWS refused to save the key: ${errorMessage(err)}.` +
              (kind === "permission"
                ? ` This machine's AWS role needs ssm:PutParameter on ${opts.path}/* and kms:Encrypt and ` +
                  `kms:GenerateDataKey on ${opts.kmsKeyId}.`
                : ""),
          );
        }
        unreachable(err);
        throw new ParameterStoreUnreachableError(`${errorMessage(err)}; the key wasn't saved`);
      }
      reached();
      cache.set(key, { value, updatedAt: new Date(now()).toISOString(), fetchedAt: now() });
    },

    async remove(service, name) {
      const key = paramName(service, name);
      generation.set(key, genOf(key) + 1);
      let removed: boolean;
      try {
        removed = await opts.client.deleteParameter(key);
      } catch (err) {
        const kind = classify(err);
        if (kind !== "unreachable") {
          reached();
          throw new KeyStoreRefusedError(
            `AWS refused to remove the key: ${errorMessage(err)}.` +
              (kind === "permission" ? ` This machine's AWS role needs ssm:DeleteParameter on ${opts.path}/*.` : ""),
          );
        }
        unreachable(err);
        throw new ParameterStoreUnreachableError(`${errorMessage(err)}; the key wasn't removed`);
      }
      reached();
      cache.set(key, { value: null, updatedAt: null, fetchedAt: now() });
      return removed;
    },

    async status(service, names): Promise<KeyStatus[]> {
      const keys = names.map((n) => paramName(service, n));
      // The panel asks AWS (so it shows keys added or removed there), except
      // while holding off during an outage; then it says what was last read.
      if (!holdingOff()) {
        try {
          await fetchIntoCache(keys);
        } catch (err) {
          if (!(err instanceof ParameterStoreUnreachableError)) throw err;
        }
      }
      return names.map((name, i) => {
        const c = cache.get(keys[i]);
        return { name, isSet: c ? c.value !== null : null, updatedAt: c?.updatedAt ?? null };
      });
    },

    __clearCache() {
      cache.clear();
      generation.clear();
      inflight.clear();
      unreachableSince = null;
      lastFailureAt = 0;
    },
  };
}
