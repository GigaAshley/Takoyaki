/**
 * agent-services/engine/types.ts — the contract a service module implements.
 *
 * An agent service is something an agent on a managed host can ask the
 * backend to do on its behalf, using credentials only the backend holds
 * (place a phone call, generate an image, ...). The engine owns everything
 * about taking the request and giving the answer: validating input,
 * queueing, rate limiting, TTLs, keys and the acting user. A service only
 * declares what it accepts and implements `handle()`.
 *
 * See ../README.md for the wire protocol and a walkthrough of adding one.
 */

import type { z } from "zod";

/** A file the agent sent alongside the request (e.g. a reference image). */
export interface ServiceAttachment {
  /** `<slot>.<ext>`, e.g. `ref.png`. */
  filename: string;
  /** Lower-case extension, without the dot. */
  ext: string;
  bytes: Buffer;
}

/** Limits for one named attachment slot a service accepts. */
export interface AttachmentSpec {
  /** Allowed lower-case extensions, without the dot. */
  extensions: readonly string[];
  /** Largest accepted file. Larger files fail the request as `malformed`. */
  maxBytes: number;
  required?: boolean;
}

/** A file the service hands back to the agent (e.g. a generated image). */
export interface ServiceOutputFile {
  /** Lower-case extension, without the dot. */
  ext: string;
  bytes: Buffer;
}

/** One instance key a service needs. Keys belong to the service alone. */
export interface InstanceKeySpec {
  /** Plain name an admin recognises, e.g. "Twilio auth token". */
  label: string;
  /** One line on where to get it, e.g. "Twilio console → Account info". */
  description: string;
  /**
   * Whether the service needs this key with the given settings (e.g. only
   * when that provider is picked). Absent = always needed. A key that isn't
   * needed is still passed to the handler when it's set.
   */
  neededWhen?: (settings: Record<string, string>) => boolean;
}

/** One choice an admin makes for a service, e.g. which provider it uses. */
export interface ServiceSettingSpec {
  label: string;
  /** One line on what it changes. */
  description: string;
  /** The values an admin picks from. */
  options: readonly { value: string; label: string }[];
  /** Used when nothing is stored. Absent = unset until an admin picks. */
  default?: string;
  /** The service isn't set up until this has a value. */
  required?: boolean;
}

/**
 * A key stored per Skynet user (e.g. their company-issued Zoho token),
 * encrypted at rest with the backend's system key so it can be used while
 * they are logged out. Only admins set it, in Admin → Services; the user
 * never sees or changes it. Values are write-only: no API ever returns one.
 */
export interface UserSecretSpec {
  /** Shown next to each person in Admin → Services. */
  label: string;
  description?: string;
  /**
   * Optional instance key of this same service (a name in `secrets`) used
   * for people with no value of their own, e.g. a company-wide default.
   * Declare it there with `neededWhen: () => false`.
   */
  fallbackKey?: string;
}

/** The Skynet user a request is acting for. */
export interface ActingUser {
  id: string;
  username: string;
}

export interface ServiceLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/** Everything a handler gets besides its validated input. */
export interface ServiceContext {
  /** Request uuid (from the request filename). */
  requestId: string;
  /** The host the request came from. Use it for per-host permission checks. */
  host: { id: string; idNum: number };
  /** Attachments, keyed by the slot name declared in `attachments`. */
  attachments: Record<string, ServiceAttachment>;
  /**
   * The service's instance keys from the key store: every key it needs with
   * the current settings (guaranteed non-empty), plus any other set ones.
   */
  secrets: Record<string, string>;
  /** The service's settings, defaults applied ("" when unset). */
  settings: Record<string, string>;
  /**
   * The user the request acts for. Set when the service declares
   * `userSecrets`; see README "Whose request is it?".
   */
  user?: ActingUser;
  /** Values of the `userSecrets` for `user`, all guaranteed non-empty. */
  userSecrets: Record<string, string>;
  log: ServiceLogger;
  now(): number;
}

export type ServiceResult<R = unknown> =
  | { ok: true; result: R; files?: ServiceOutputFile[] }
  | {
      ok: false;
      /** Machine-readable failure code, snake_case. */
      code: string;
      message?: string;
      /** Extra fields merged into the error object the agent sees. */
      details?: Record<string, unknown>;
    };

export interface ServiceDefinition<
  S extends z.ZodType = z.ZodType,
  R = unknown,
> {
  /** Service name agents put in the request envelope. kebab-case. */
  name: string;
  /** What an admin calls it in Admin → Services, e.g. "Phone calls". */
  title: string;
  /** One line for logs, docs and Admin → Services. */
  description: string;
  /**
   * Input schema. Use `z.strictObject(...)` so a mistyped field fails as
   * `malformed` instead of being silently ignored.
   */
  input: S;
  /** Named attachment slots. Requests naming any other slot are `malformed`. */
  attachments?: Record<string, AttachmentSpec>;
  /**
   * Instance keys the handler needs, keyed by an UPPER_SNAKE name. An admin
   * sets them in Admin → Services; they are never read from the environment.
   * If a needed one is unset the engine answers `not_configured` without
   * calling the handler. A service never shares a key with the app's own
   * voice features; an operator who wants one account behind both enters it
   * in both places.
   */
  secrets?: Record<string, InstanceKeySpec>;
  /**
   * Choices an admin makes in Admin → Services, keyed by a lower_snake name
   * (e.g. which provider). A required one without a value leaves the service
   * not set up (`not_configured`).
   */
  settings?: Record<string, ServiceSettingSpec>;
  /**
   * Other services whose setup this one relies on (e.g. phone transcribes
   * replies with speech to text). Admin → Services lists one that isn't set
   * up as missing here too. The engine doesn't refuse requests over it.
   */
  uses?: readonly string[];
  /**
   * Failure codes this service returns when the service itself is at fault
   * (a rejected key, a provider that is down or refusing), as opposed to a
   * bad request or an outcome that is no failure (nobody picked up). The
   * last of these, unless followed by a success, shows the service as
   * failing. `internal` always counts.
   */
  faultCodes?: readonly string[];
  /**
   * Per-user secrets, keyed by an UPPER_SNAKE name. Declaring any makes the
   * engine work out which user the request acts for (ctx.user) and load
   * their values (ctx.userSecrets). A missing value without a fallback is
   * answered `no_user_secret`, with a message telling the agent who can set
   * it.
   */
  userSecrets?: Record<string, UserSecretSpec>;
  /**
   * How long a request stays worth answering, measured from the envelope's
   * `requested_at`. Requests dequeued after this get `expired`. Keep it at or
   * under the host-side helper's own timeout so the backend never does work
   * for a caller that has already given up.
   */
  ttlMs: number;
  /** Max requests running at once for this service. Default 1. */
  concurrency?: number;
  /**
   * Optional serialization key. Requests with the same key never run at the
   * same time (e.g. one phone call per recipient), independent of
   * `concurrency`.
   */
  serializeBy?: (input: z.output<S>) => string;
  /** Fleet-wide requests-per-minute cap, read once at engine start. */
  rateLimitPerMinute?: () => number;
  /** Pending-queue cap. Requests past it get `queue_full`. Default 1000. */
  maxQueueDepth?: number;
  handle(input: z.output<S>, ctx: ServiceContext): Promise<ServiceResult<R>>;
}

/**
 * Identity helper that gives `handle()` its input type from the schema.
 * Every service module default-exports `defineService({...})`.
 */
export function defineService<S extends z.ZodType, R>(
  def: ServiceDefinition<S, R>,
): ServiceDefinition<S, R> {
  return def;
}

/** Successful result, optionally with output files. */
export function ok<R>(
  result: R,
  files?: ServiceOutputFile[],
): ServiceResult<R> {
  return files && files.length > 0
    ? { ok: true, result, files }
    : { ok: true, result };
}

/** Failed result. `details` fields are merged into the agent-visible error. */
export function fail(
  code: string,
  message?: string,
  details?: Record<string, unknown>,
): ServiceResult<never> {
  const r: ServiceResult<never> = { ok: false, code };
  if (message !== undefined) r.message = message;
  if (details !== undefined) r.details = details;
  return r;
}

/** Failure codes the engine itself produces, for any service. */
export type EngineErrorCode =
  | "malformed"
  | "unknown_service"
  | "expired"
  | "queue_full"
  | "not_configured"
  | "not_enabled"
  | "internal"
  // acting-user resolution (services with userSecrets)
  | "ambiguous_user"
  | "unknown_user"
  | "not_permitted"
  | "no_user_secret";
