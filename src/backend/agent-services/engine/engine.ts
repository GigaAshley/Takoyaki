/**
 * agent-services/engine/engine.ts — turns a machine's service request into
 * its answer.
 *
 * submit(), per request, as it arrives (http/routes.ts):
 *   service lookup → switched on for this machine? → input schema →
 *   attachments → enqueue
 * Any failure there is answered straight away (malformed, unknown_service,
 * not_enabled, queue_full) without queueing.
 *
 * Queued job, per request:
 *   TTL → settings and keys from the stores (not_configured when a required
 *   one is missing) → acting user + their keys (services with userSecrets)
 *   → rate limit → handle() → write response
 *
 * Core handlers (identity-reactivate) ride the same requests but are the
 * app's own machinery, not services: never switched, never recorded. Every
 * service answer is recorded (agent-services/admin/usage.ts).
 *
 * Every submitted request resolves to exactly one answer; submit() never
 * rejects.
 */

import { systemLogger } from "../../utils/logger.js";
import {
  attachmentError,
  buildResponse,
  engineFailure,
  type EngineFailure,
  type IncomingRequest,
  type WireResponse,
} from "./protocol.js";
import { JobQueue } from "./queue.js";
import { createTokenBucket, type TokenBucket } from "./token-bucket.js";
import type {
  ActingUser,
  ServiceAttachment,
  ServiceContext,
  ServiceDefinition,
  ServiceOutputFile,
  ServiceResult,
} from "./types.js";

export interface RequestHost {
  id: string;
  idNum: number;
  /** The machine behind the host row (hosts.machine_id); grants are per machine. */
  machineId: string;
}

export type ActingUserResolution =
  | { ok: true; user: ActingUser }
  | {
      ok: false;
      code: "ambiguous_user" | "unknown_user" | "not_permitted";
      message: string;
    };

export interface EngineDeps {
  /** The services: switched per machine, set up in Admin → Services. */
  services: readonly ServiceDefinition[];
  /** The app's own request handlers: answered for every machine, never listed. */
  coreHandlers?: readonly ServiceDefinition[];
  /** Whether `service` is switched on for `machineId`. */
  isEnabled(service: string, machineId: string): Promise<boolean>;
  /** A service's instance key from the key store, or null. */
  getKey(service: string, name: string): Promise<string | null>;
  /** A service's settings, defaults applied ("" when unset). */
  getSettings(def: ServiceDefinition): Promise<Record<string, string>>;
  /** Called once per service response. Must not throw. */
  recordUsage?: (r: {
    service: string;
    machineId: string;
    hostId: number;
    ok: boolean;
    code: string | null;
    fault: boolean;
  }) => Promise<void>;
  /**
   * Work out which user a request from `hostIdNum` acts for, optionally
   * named by the envelope's `as_user`. Required if any service declares
   * userSecrets.
   */
  resolveActingUser?: (
    hostIdNum: number,
    asUser: string | undefined,
  ) => Promise<ActingUserResolution>;
  /** Decrypted per-user secret, or null when none is stored. */
  loadUserSecret?: (
    userId: string,
    service: string,
    name: string,
  ) => Promise<string | null>;
  now?: () => number;
  createTokenBucket?: (rpm: number) => TokenBucket;
  /**
   * Most attachment bytes held by queued and running requests, across every
   * service (default MAX_HELD_ATTACHMENT_BYTES). Past it, new requests with
   * attachments are refused as queue_full.
   */
  maxHeldAttachmentBytes?: number;
}

/** A request's answer: the response body and any output files it names. */
export interface ServiceAnswer {
  body: WireResponse;
  files: ServiceOutputFile[];
}

export interface AgentServiceEngine {
  /** Validate, queue and run one request. Resolves with its answer; never rejects. */
  submit(host: RequestHost, request: IncomingRequest): Promise<ServiceAnswer>;
  /** Stop starting new jobs. Running handlers finish. */
  stop(): void;
  queueSnapshot(): Record<string, { pending: number; running: number }>;
}

const DEFAULT_MAX_QUEUE_DEPTH = 1000;
/** Attachments wait in memory; this bounds them on a small host. */
export const MAX_HELD_ATTACHMENT_BYTES = 256 * 1024 * 1024;
const USER_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface ServiceRuntime {
  def: ServiceDefinition;
  /** A core handler: no switch, no usage record. */
  core: boolean;
  queue: JobQueue;
  bucket: TokenBucket | null;
}

/** What an admin does to fix a missing key or setting. */
const ADMIN_FIX = "an admin can set it up in Admin → Services";

export function createAgentServiceEngine(deps: EngineDeps): AgentServiceEngine {
  const now = deps.now ?? (() => Date.now());
  const makeBucket = deps.createTokenBucket ?? createTokenBucket;
  const maxHeldBytes = deps.maxHeldAttachmentBytes ?? MAX_HELD_ATTACHMENT_BYTES;
  let heldBytes = 0;

  const runtimes = new Map<string, ServiceRuntime>();
  const all = [
    ...deps.services.map((def) => ({ def, core: false })),
    ...(deps.coreHandlers ?? []).map((def) => ({ def, core: true })),
  ];
  for (const { def, core } of all) {
    if (runtimes.has(def.name))
      throw new Error(`duplicate agent service: ${def.name}`);
    for (const name of Object.keys(def.userSecrets ?? {})) {
      if (!USER_SECRET_NAME_RE.test(name)) {
        throw new Error(
          `${def.name}: user secret name must be UPPER_SNAKE: ${name}`,
        );
      }
      if (!deps.resolveActingUser || !deps.loadUserSecret) {
        throw new Error(
          `${def.name} declares userSecrets but the engine has no user secret store`,
        );
      }
    }
    const rpm = def.rateLimitPerMinute?.();
    runtimes.set(def.name, {
      def,
      core,
      bucket: rpm !== undefined ? makeBucket(Math.max(1, rpm)) : null,
      queue: new JobQueue({
        concurrency: def.concurrency ?? 1,
        maxDepth: def.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
        onJobError: (err) =>
          systemLogger.error("agent-services: job escaped its error handling", {
            operation: "agent_services_job_error",
            service: def.name,
            error: err instanceof Error ? err.message : String(err),
          }),
      }),
    });
  }

  async function respond(
    host: RequestHost,
    id: string,
    service: string | null,
    result: ServiceResult | EngineFailure,
  ): Promise<ServiceAnswer> {
    const rt = service ? runtimes.get(service) : undefined;
    if (rt && !rt.core && deps.recordUsage) {
      const code = result.ok === true ? null : result.code;
      await deps.recordUsage({
        service: rt.def.name,
        machineId: host.machineId,
        hostId: host.idNum,
        ok: result.ok === true,
        code,
        fault:
          code !== null &&
          (code === "internal" || (rt.def.faultCodes ?? []).includes(code)),
      });
    }
    const files = result.ok === true ? (result.files ?? []) : [];
    systemLogger.info("agent-services: answered", {
      operation: "agent_services_respond",
      service,
      requestId: id,
      fleetHostId: host.id,
      machineId: host.machineId,
      ok: result.ok,
      code: result.ok === true ? undefined : result.code,
      files: files.length,
    });
    return { body: buildResponse(service, result, files), files };
  }

  /** Null if the service is on for the host's machine; else the refusal. */
  async function refusedAsOff(
    host: RequestHost,
    id: string,
    service: string,
  ): Promise<ServiceAnswer | null> {
    let enabled: boolean;
    try {
      enabled = await deps.isEnabled(service, host.machineId);
    } catch (err) {
      return respond(
        host,
        id,
        service,
        engineFailure(
          "internal",
          `switch lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    if (enabled) return null;
    return respond(
      host,
      id,
      service,
      engineFailure(
        "not_enabled",
        `${service} isn't switched on for this machine; an admin can switch it on in Admin → Services`,
      ),
    );
  }

  async function runJob(
    rt: ServiceRuntime,
    host: RequestHost,
    id: string,
    receivedAt: number,
    input: unknown,
    attachments: Record<string, ServiceAttachment>,
    asUser: string | undefined,
  ): Promise<ServiceAnswer> {
    const { def } = rt;
    const answer = (result: ServiceResult | EngineFailure) =>
      respond(host, id, def.name, result);

    if (now() > receivedAt + def.ttlMs) {
      return answer(
        engineFailure("expired", "request expired before it could run"),
      );
    }

    // Switched off while it waited in the queue: don't run it.
    if (!rt.core) {
      const off = await refusedAsOff(host, id, def.name);
      if (off) return off;
    }

    const notConfigured = (what: string) =>
      answer(
        engineFailure(
          "not_configured",
          `${def.name} isn't set up yet: it needs ${what}; ${ADMIN_FIX}`,
        ),
      );
    const lookupFailed = (what: string, err: unknown) =>
      answer(
        engineFailure(
          "internal",
          `${what} lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

    let settings: Record<string, string>;
    try {
      settings = await deps.getSettings(def);
    } catch (err) {
      return lookupFailed("settings", err);
    }
    for (const [name, spec] of Object.entries(def.settings ?? {})) {
      if (spec.required && !settings[name]) {
        return notConfigured(`a choice of ${spec.label.toLowerCase()}`);
      }
    }

    const secrets: Record<string, string> = {};
    for (const [name, spec] of Object.entries(def.secrets ?? {})) {
      const needed = spec.neededWhen?.(settings) ?? true;
      let value: string | null;
      try {
        value = await deps.getKey(def.name, name);
      } catch (err) {
        if (needed) {
          // The reason (an AWS refusal or outage) names the store's path,
          // role and encryption key: for admins, not agents.
          systemLogger.warn("agent-services: a needed key couldn't be read", {
            operation: "agent_services_key_unreadable",
            service: def.name,
            name,
            error: err instanceof Error ? err.message : String(err),
          });
          return answer(
            engineFailure(
              "internal",
              `${def.name} can't read its keys right now; an admin can see why in Admin → Services`,
            ),
          );
        }
        // A key these settings don't use can't fail the request.
        systemLogger.warn("agent-services: unused key couldn't be read", {
          operation: "agent_services_unused_key_unreadable",
          service: def.name,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (value) {
        secrets[name] = value;
      } else if (needed) {
        return notConfigured(`its ${spec.label}`);
      }
    }

    let user: ActingUser | undefined;
    const userSecrets: Record<string, string> = {};
    const userSecretSpecs = Object.entries(def.userSecrets ?? {});
    if (userSecretSpecs.length > 0) {
      let resolution: ActingUserResolution;
      try {
        resolution = await deps.resolveActingUser!(host.idNum, asUser);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return answer(
          engineFailure("internal", `user lookup failed: ${message}`),
        );
      }
      if (resolution.ok === false) {
        return answer(engineFailure(resolution.code, resolution.message));
      }
      user = resolution.user;
      for (const [name, spec] of userSecretSpecs) {
        let value: string | null;
        try {
          value = await deps.loadUserSecret!(user.id, def.name, name);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return answer(
            engineFailure("internal", `secret lookup failed: ${message}`),
          );
        }
        if (!value && spec.fallbackKey)
          value = secrets[spec.fallbackKey] || null;
        if (!value) {
          return answer(
            engineFailure(
              "no_user_secret",
              `${user.username} has no ${spec.label} for ${def.name}; an admin can set it for them in Admin → Services`,
            ),
          );
        }
        userSecrets[name] = value;
      }
    }

    if (rt.bucket) await rt.bucket.acquire();

    const logContext = {
      service: def.name,
      requestId: id,
      fleetHostId: host.id,
      ...(user ? { actingUser: user.username } : {}),
    };
    const ctx: ServiceContext = {
      requestId: id,
      host,
      attachments,
      secrets,
      settings,
      user,
      userSecrets,
      now,
      log: {
        info: (m, c) =>
          systemLogger.info(`${def.name}: ${m}`, { ...logContext, ...c }),
        warn: (m, c) =>
          systemLogger.warn(`${def.name}: ${m}`, { ...logContext, ...c }),
      },
    };

    let result: ServiceResult;
    try {
      result = await def.handle(input, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      systemLogger.error("agent-services: handler threw", {
        operation: "agent_services_handler_threw",
        ...logContext,
        error: message,
      });
      result = engineFailure("internal", message);
    }
    return answer(result);
  }

  async function submitOne(
    host: RequestHost,
    request: IncomingRequest,
  ): Promise<ServiceAnswer> {
    const { id } = request;
    const receivedAt = now();
    const rt = runtimes.get(request.service);
    if (!rt) {
      return respond(
        host,
        id,
        request.service,
        engineFailure(
          "unknown_service",
          `no agent service named "${request.service}"`,
        ),
      );
    }
    const { def } = rt;
    if (!rt.core) {
      const off = await refusedAsOff(host, id, def.name);
      if (off) return off;
    }
    const malformed = (message: string) =>
      respond(host, id, def.name, engineFailure("malformed", message));

    const input = def.input.safeParse(request.input);
    if (!input.success) {
      const issue = input.error.issues[0];
      const where =
        issue && issue.path.length > 0 ? issue.path.join(".") : "input";
      return malformed(`${where}: ${issue?.message ?? "invalid"}`);
    }

    const specs = def.attachments ?? {};
    const attachments: Record<string, ServiceAttachment> = {};
    for (const [slot, file] of Object.entries(request.attachments)) {
      const spec = specs[slot];
      if (!spec) return malformed(`unexpected attachment: ${slot}`);
      const problem = attachmentError(slot, file, spec);
      if (problem) return malformed(problem);
      attachments[slot] = {
        filename: `${slot}.${file.ext}`,
        ext: file.ext,
        bytes: file.bytes,
      };
    }
    for (const [slot, spec] of Object.entries(specs)) {
      if (spec.required && !attachments[slot])
        return malformed(`attachment ${slot} is required`);
    }

    const bytes = Object.values(attachments).reduce(
      (n, a) => n + a.bytes.byteLength,
      0,
    );
    if (bytes > 0 && heldBytes + bytes > maxHeldBytes) {
      systemLogger.warn(
        "agent-services: too many attachment bytes waiting; refusing",
        {
          operation: "agent_services_attachment_budget_full",
          service: def.name,
          requestId: id,
          heldBytes,
          bytes,
        },
      );
      return respond(
        host,
        id,
        def.name,
        engineFailure(
          "queue_full",
          "too many large requests waiting, try again later",
        ),
      );
    }

    let resolveAnswer!: (a: ServiceAnswer) => void;
    const done = new Promise<ServiceAnswer>((r) => (resolveAnswer = r));
    heldBytes += bytes;
    const queued = rt.queue.enqueue({
      key: def.serializeBy?.(input.data),
      run: async () => {
        try {
          resolveAnswer(
            await runJob(
              rt,
              host,
              id,
              receivedAt,
              input.data,
              attachments,
              request.asUser,
            ).catch((err) =>
              respond(
                host,
                id,
                def.name,
                engineFailure(
                  "internal",
                  err instanceof Error ? err.message : String(err),
                ),
              ),
            ),
          );
        } finally {
          heldBytes -= bytes;
        }
      },
    });
    if (!queued) {
      heldBytes -= bytes;
      return respond(
        host,
        id,
        def.name,
        engineFailure("queue_full", "queue full, try again later"),
      );
    }
    systemLogger.info("agent-services: queued", {
      operation: "agent_services_queued",
      service: def.name,
      requestId: id,
      fleetHostId: host.id,
      attachments: Object.keys(attachments).length,
      ...rt.queue.snapshot(),
    });
    return done;
  }

  return {
    async submit(host, request) {
      try {
        return await submitOne(host, request);
      } catch (err) {
        systemLogger.error("agent-services: submit threw", {
          operation: "agent_services_submit_threw",
          requestId: request.id,
          fleetHostId: host.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          body: buildResponse(
            request.service,
            engineFailure(
              "internal",
              err instanceof Error ? err.message : String(err),
            ),
          ),
          files: [],
        };
      }
    },
    stop() {
      for (const rt of runtimes.values()) rt.queue.stop();
    },
    queueSnapshot() {
      const out: Record<string, { pending: number; running: number }> = {};
      for (const [name, rt] of runtimes) out[name] = rt.queue.snapshot();
      return out;
    },
  };
}
