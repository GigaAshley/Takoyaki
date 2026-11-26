/**
 * Speech-to-text provider abstraction.
 *
 * Every STT backend implements the same contract: the raw clip uploaded by
 * the browser (bytes + mimetype + extension) in, a plain transcript string
 * out. `handleTranscribe` in routes/voice.ts owns everything around that call
 * (disk-bank, retries, slash-command transform, HTTP status mapping) so a
 * provider only has to translate audio → text and classify its own errors.
 *
 * The provider is chosen per instance with the `STT_PROVIDER` env var:
 *
 *   bedrock     (default) Amazon Nova 2 Sonic on Bedrock. Keeps audio inside
 *               AWS for instances covered by an AWS BAA. IMDS credentials.
 *   elevenlabs  ElevenLabs Scribe v2.            Needs ELEVENLABS_API_KEY.
 *   mistral     Mistral Voxtral Mini Transcribe. Needs MISTRAL_API_KEY.
 *   groq        Whisper Large v3 Turbo on Groq.  Needs GROQ_API_KEY.
 *
 * Optional backup, `STT_FALLBACK_PROVIDER` (same values, or `none`): when the
 * selected provider can't transcribe a recording, or is slow to answer, the
 * same recording goes to the backup (transcribeWithFallback). Unset keeps the
 * single-provider behaviour exactly. A backup off AWS sends audio to a third
 * party whenever the selected provider fails or stalls.
 *
 * Optional overrides for the HTTP providers:
 *   STT_MODEL     model id sent to the selected provider (defaults below);
 *                 a backup always uses its own default.
 *   STT_LANGUAGE  ISO-639-1 code (e.g. "en"); omit for auto-detect.
 *
 * Unset STT_PROVIDER keeps the pre-existing Bedrock behaviour exactly, so a
 * BAA instance never sends audio off-AWS unless someone opts in explicitly.
 */

import { databaseLogger } from "../utils/logger.js";
import { SttDeadlineError, SttHttpError, SttNotConfiguredError } from "./stt-errors.js";
import { bedrockSttProvider } from "./stt-bedrock.js";
import {
  elevenLabsSttProvider,
  groqSttProvider,
  mistralSttProvider,
} from "./stt-http-providers.js";

export interface SttInput {
  /** Raw uploaded bytes exactly as the browser sent them (WebM/Opus in prod). */
  audio: Buffer;
  /** Multipart mimetype, e.g. `audio/webm;codecs=opus`. */
  mimetype: string;
  /** File extension derived from the mimetype (`webm`, `mp4`, ...). */
  ext: string;
  /**
   * Per-request timeout for the HTTP providers. Defaults to 60 s, which fits
   * a dictated clip; agent-supplied files can be much longer.
   */
  timeoutMs?: number;
  /**
   * ISO-639-1 code pinning this request's language, overriding STT_LANGUAGE.
   * For callers that know what language the audio is in (agent-phone calls
   * are scripted in English); auto-detect misreads very short clips. Bedrock
   * ignores it.
   */
  language?: string;
  /**
   * How long the audio is, when the caller knows (voice mode measures each
   * piece). Sets how long the selected provider gets before the backup is
   * asked too; estimated from the byte size when absent.
   */
  durationMs?: number;
  /** Cancels the request (the other provider won, or the deadline passed). */
  signal?: AbortSignal;
  /**
   * Provider setup in the server-settings shape (STT_PROVIDER, keys,
   * STT_LANGUAGE …), for callers with their own (the stt agent service).
   * Absent = the server's settings, which voice uses.
   */
  env?: NodeJS.ProcessEnv;
}

export interface SttProvider {
  readonly id: SttProviderId;
  transcribe(input: SttInput): Promise<string>;
  /** Transient failure worth an automatic retry (throttling, 5xx, network). */
  isRetriable(err: unknown): boolean;
  /** Misconfiguration / auth failure → route answers 503 "STT unavailable". */
  isUnavailable(err: unknown): boolean;
  /**
   * The least time this provider can take per minute of audio when healthy
   * (Bedrock streams audio in at ~5× real time). Added to the wait before the
   * backup is asked, so a healthy provider is never raced just for its pace.
   */
  readonly minMsPerAudioMinute?: number;
}

export const STT_PROVIDER_IDS = ["bedrock", "elevenlabs", "mistral", "groq"] as const;
export type SttProviderId = (typeof STT_PROVIDER_IDS)[number];

/** Display names for the admin System page. */
export const STT_PROVIDER_LABELS: Record<SttProviderId, string> = {
  bedrock: "Amazon Nova Sonic",
  elevenlabs: "ElevenLabs",
  mistral: "Mistral",
  groq: "Groq",
};

const PROVIDERS: Record<SttProviderId, SttProvider> = {
  bedrock: bedrockSttProvider,
  elevenlabs: elevenLabsSttProvider,
  mistral: mistralSttProvider,
  groq: groqSttProvider,
};

/**
 * Resolve the provider for this instance from `STT_PROVIDER`. Read on every
 * call (cheap) so tests and env reloads don't need a module reset.
 *
 * @throws SttNotConfiguredError for an unrecognised value — we never silently
 *   fall back to a different provider, since that could route PHI somewhere
 *   the operator didn't choose.
 */
export function resolveSttProvider(env: NodeJS.ProcessEnv = process.env): SttProvider {
  const raw = (env.STT_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "") return PROVIDERS.bedrock;
  if ((STT_PROVIDER_IDS as readonly string[]).includes(raw)) {
    return PROVIDERS[raw as SttProviderId];
  }
  throw new SttNotConfiguredError(
    `unknown STT_PROVIDER="${raw}" (expected one of: ${STT_PROVIDER_IDS.join(", ")})`,
  );
}

/** STT_FALLBACK_PROVIDER as resolved; `ignored` values are never mapped elsewhere. */
export type SttFallbackConfig =
  | { kind: "none" }
  | { kind: "ok"; provider: SttProvider }
  | { kind: "ignored"; raw: string; reason: "unknown" | "same-as-primary" };

/**
 * Resolve the backup provider from `STT_FALLBACK_PROVIDER`. Unset, blank or
 * `none` → no backup. An unknown value or the selected provider again →
 * ignored (no backup used), so audio never reaches a provider nobody named.
 */
export function resolveSttFallback(env: NodeJS.ProcessEnv = process.env): SttFallbackConfig {
  const raw = (env.STT_FALLBACK_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "" || raw === "none") return { kind: "none" };
  if (!(STT_PROVIDER_IDS as readonly string[]).includes(raw)) return { kind: "ignored", raw, reason: "unknown" };
  const primary = (env.STT_PROVIDER ?? "").trim().toLowerCase() || "bedrock";
  if (raw === primary) return { kind: "ignored", raw, reason: "same-as-primary" };
  return { kind: "ok", provider: PROVIDERS[raw as SttProviderId] };
}

/**
 * Call the instance's STT provider with auto-retry on errors the provider
 * classifies as transient (Bedrock stream errors, HTTP 429/5xx, network).
 * Server-side retry catches these before the user sees a 502 and loses their
 * dictated message (the transcribe-bank still preserves the raw upload, but
 * by then the client has already dropped the blob and returned to idle).
 * Total attempts capped at maxAttempts; backoff is linear (500ms × attempt).
 * Rethrows the last error unchanged when all attempts exhaust or when the
 * error is non-retriable — the caller's existing 502/503 handling still fires.
 *
 * Shared by POST /voice/transcribe and the `stt` agent service.
 */
export async function transcribeWithRetries(
  provider: SttProvider,
  input: SttInput,
  maxAttempts: number = 3,
  reqId?: string,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    input.signal?.throwIfAborted();
    try {
      return await provider.transcribe(input);
    } catch (err: unknown) {
      lastErr = err;
      // Cancelled by the caller: nobody wants the answer any more.
      if (input.signal?.aborted) throw err;
      if (attempt < maxAttempts && provider.isRetriable(err)) {
        const backoffMs = 500 * attempt;
        const errName = (err as { name?: string })?.name ?? "unknown";
        const errMessage = err instanceof Error ? err.message : String(err);
        databaseLogger.warn(
          `[voice-server] transcribe-retry${reqId ? ` reqId=${reqId}` : ""} provider=${provider.id} attempt=${attempt}/${maxAttempts} errName=${errName} errMessage="${errMessage}" backoffMs=${backoffMs}`,
          { operation: "voice_transcribe_retry", reqId, provider: provider.id, attempt, maxAttempts, errName, backoffMs },
        );
        await abortableDelay(backoffMs, input.signal);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Wait `ms`, or reject at once when `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** STT_FALLBACK_PROVIDER values already warned about (logged once each). */
const warnedFallbackConfig = new Set<string>();

/** Test hook: let ignored-config warnings log again. */
export function clearSttFallbackWarnings(): void {
  warnedFallbackConfig.clear();
}

/**
 * A provider error meaning "out of credit / quota", not "slow down". Matched
 * on the response body: ElevenLabs says quota_exceeded, OpenAI-style APIs
 * insufficient_quota.
 */
export function isSttQuotaExhausted(err: unknown): boolean {
  return err instanceof SttHttpError && /quota/i.test(err.body);
}

/**
 * Why a provider's turn ended, for the fallback log lines. Quota only counts
 * among errors the provider already classes as unavailable — a rate-limit 429
 * that merely mentions "quota" was retried and is "retries-exhausted".
 */
function failureReason(provider: SttProvider, err: unknown): string {
  if (provider.isUnavailable(err)) return isSttQuotaExhausted(err) ? "quota" : "unavailable";
  if (provider.isRetriable(err)) return "retries-exhausted";
  return "error";
}

function errFields(err: unknown): { errName: string; errMessage: string } {
  return {
    errName: (err as { name?: string })?.name ?? "unknown",
    errMessage: err instanceof Error ? err.message : String(err),
  };
}

/**
 * How a transcription ended. On failure, `provider` is the one whose error
 * `err` is (the backup's when one ran) — classify `err` with it; undefined
 * when STT_PROVIDER itself is invalid.
 */
export type SttOutcome =
  | { kind: "ok"; text: string; provider: SttProvider }
  | { kind: "failed"; err: unknown; provider: SttProvider | undefined };

export interface SttFallbackOptions {
  /** Short id tying this request's log lines together (generated if omitted). */
  reqId?: string;
  /** Who is transcribing, for logs: transcribe, stt-service, phone. */
  caller: string;
  /** Tries per provider (see transcribeWithRetries). */
  maxAttempts?: number;
  /**
   * Overall limit: past it every request still running is cancelled and the
   * outcome is an SttDeadlineError. Absent = no overall limit (each try keeps
   * its own per-request timeout).
   */
  deadlineMs?: number;
  /** The caller stopped waiting (the browser went away): cancel everything, outcome failed. */
  signal?: AbortSignal;
  /** Provider setup to use instead of the server's settings (see SttInput.env). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: one provider's turn (defaults to transcribeWithRetries). */
  attempt?: (provider: SttProvider, input: SttInput, maxAttempts: number, reqId: string) => Promise<string>;
}

/** The selected provider gets this long, plus STT_HEDGE_PER_MINUTE_MS per minute of audio, before the backup is asked too. */
export const STT_HEDGE_BASE_MS = 10_000;
export const STT_HEDGE_PER_MINUTE_MS = 3_000;
/**
 * Byte rate used to guess a recording's length when the caller didn't say
 * (agent files, phone replies; voice mode always says). Set at the low end
 * of voice formats (~32 kbit/s) so a guess errs long: the backup then waits a
 * little more rather than being asked for a recording that isn't slow.
 */
const ESTIMATED_AUDIO_BYTES_PER_SECOND = 4_000;

/** How long the selected provider gets before the backup is asked too. */
export function sttHedgeDelayMs(input: Pick<SttInput, "audio" | "durationMs">, provider?: Pick<SttProvider, "minMsPerAudioMinute">): number {
  const audioMs =
    input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? input.durationMs
      : (input.audio.length / ESTIMATED_AUDIO_BYTES_PER_SECOND) * 1000;
  const perMinuteMs = STT_HEDGE_PER_MINUTE_MS + (provider?.minMsPerAudioMinute ?? 0);
  return Math.round(STT_HEDGE_BASE_MS + (perMinuteMs * audioMs) / 60_000);
}

/**
 * Transcribe with the selected provider (its normal retries). The backup
 * (STT_FALLBACK_PROVIDER), with the same tries and per-try timeout, gets the
 * same recording when either:
 *   - the selected provider's turn ends in ANY failure, or
 *   - it hasn't answered after sttHedgeDelayMs — then both run, the first
 *     good answer wins and the other request is cancelled.
 * Fails only once every provider that ran has failed (the backup's error is
 * the one returned), or when `deadlineMs` passes. No memory between
 * recordings: every call starts with the selected provider. An invalid
 * STT_PROVIDER is not covered — the backup is for a provider in trouble, not
 * a broken setting. With no backup configured this is exactly
 * transcribeWithRetries (plus the deadline, when given).
 *
 * Shared by POST /voice/transcribe, the `stt` agent service and agent-phone.
 */
export async function transcribeWithFallback(input: SttInput, opts: SttFallbackOptions): Promise<SttOutcome> {
  const env = opts.env ?? process.env;
  // The providers read their key and language from the same setup.
  if (opts.env) input = { ...input, env: opts.env };
  const reqId = opts.reqId ?? Math.random().toString(36).slice(2, 10);
  const maxAttempts = opts.maxAttempts ?? 3;
  const attempt = opts.attempt ?? transcribeWithRetries;
  const caller = opts.caller;

  let primary: SttProvider;
  try {
    primary = resolveSttProvider(env);
  } catch (err) {
    return { kind: "failed", err, provider: undefined };
  }

  const fallback = resolveSttFallback(env);
  if (fallback.kind === "ignored" && !warnedFallbackConfig.has(fallback.raw)) {
    warnedFallbackConfig.add(fallback.raw);
    databaseLogger.warn(
      `[voice-server] transcribe-fallback-config-ignored value="${fallback.raw}" reason=${fallback.reason}`,
      { operation: "voice_transcribe_fallback_config", reason: fallback.reason },
    );
  }
  const backup = fallback.kind === "ok" ? fallback.provider : null;

  const startedAt = Date.now();
  const primaryAbort = new AbortController();
  const backupAbort = new AbortController();
  let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<SttOutcome>((resolve) => {
    let settled = false;
    let primaryErr: unknown;
    let primaryFailed = false;
    let backupStarted = false;
    let backupErr: unknown;
    let backupFailed = false;

    const finish = (outcome: SttOutcome) => {
      if (settled) return;
      settled = true;
      if (hedgeTimer !== null) clearTimeout(hedgeTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      // Whoever is still running lost: cancel it, its answer is ignored.
      primaryAbort.abort();
      backupAbort.abort();
      resolve(outcome);
    };

    /** Both providers have failed: report the backup's error, as before. */
    const bothFailed = (b: SttProvider) => {
      const second = errFields(backupErr);
      const backupReason = failureReason(b, backupErr);
      databaseLogger.warn(
        `[voice-server] transcribe-fallback-failed reqId=${reqId} caller=${caller} from=${primary.id} to=${b.id} reason=${backupReason} errName=${second.errName} errMessage="${second.errMessage}"`,
        { operation: "voice_transcribe_fallback_failed", reqId, caller, from: primary.id, to: b.id, reason: backupReason },
      );
      finish({ kind: "failed", err: backupErr, provider: b });
    };

    const startBackup = (b: SttProvider) => {
      backupStarted = true;
      attempt(b, { ...input, signal: backupAbort.signal }, maxAttempts, reqId).then(
        (text) => {
          if (settled) return;
          databaseLogger.info(
            `[voice-server] transcribe-fallback-ok reqId=${reqId} caller=${caller} from=${primary.id} to=${b.id} textLen=${text.length} elapsedMs=${Date.now() - startedAt} primaryFailed=${primaryFailed}`,
            { operation: "voice_transcribe_fallback_ok", reqId, caller, from: primary.id, to: b.id },
          );
          finish({ kind: "ok", text, provider: b });
        },
        (err: unknown) => {
          if (settled) return;
          backupFailed = true;
          backupErr = err;
          if (primaryFailed) {
            bothFailed(b);
            return;
          }
          // Asked early and failed: the selected provider is still the hope.
          const e = errFields(err);
          databaseLogger.warn(
            `[voice-server] transcribe-hedge-backup-failed reqId=${reqId} caller=${caller} from=${primary.id} to=${b.id} errName=${e.errName} errMessage="${e.errMessage}"`,
            { operation: "voice_transcribe_hedge_backup_failed", reqId, caller, from: primary.id, to: b.id },
          );
        },
      );
    };

    attempt(primary, { ...input, signal: primaryAbort.signal }, maxAttempts, reqId).then(
      (text) => {
        if (settled) return;
        if (backupStarted) {
          databaseLogger.info(
            `[voice-server] transcribe-hedge-primary-won reqId=${reqId} caller=${caller} provider=${primary.id} backup=${backup?.id ?? "none"} elapsedMs=${Date.now() - startedAt}`,
            { operation: "voice_transcribe_hedge_primary_won", reqId, caller, provider: primary.id },
          );
        }
        finish({ kind: "ok", text, provider: primary });
      },
      (err: unknown) => {
        if (settled) return;
        primaryFailed = true;
        primaryErr = err;
        if (!backup) {
          finish({ kind: "failed", err, provider: primary });
          return;
        }
        if (backupStarted) {
          if (backupFailed) bothFailed(backup);
          // Otherwise the backup is already running: wait for it.
          return;
        }
        const reason = failureReason(primary, primaryErr);
        const first = errFields(primaryErr);
        databaseLogger.warn(
          `[voice-server] transcribe-fallback reqId=${reqId} caller=${caller} from=${primary.id} to=${backup.id} reason=${reason} errName=${first.errName} errMessage="${first.errMessage}"`,
          { operation: "voice_transcribe_fallback", reqId, caller, from: primary.id, to: backup.id, reason },
        );
        startBackup(backup);
      },
    );

    if (backup) {
      const delayMs = sttHedgeDelayMs(input, primary);
      hedgeTimer = setTimeout(() => {
        hedgeTimer = null;
        if (settled || backupStarted) return;
        databaseLogger.warn(
          `[voice-server] transcribe-hedge reqId=${reqId} caller=${caller} from=${primary.id} to=${backup.id} afterMs=${delayMs} reason=slow`,
          { operation: "voice_transcribe_hedge", reqId, caller, from: primary.id, to: backup.id, afterMs: delayMs },
        );
        startBackup(backup);
      }, delayMs);
    }

    const callerSignal = opts.signal;
    if (callerSignal) {
      const onCallerAbort = () => {
        if (settled) return;
        databaseLogger.info(
          `[voice-server] transcribe-caller-gone reqId=${reqId} caller=${caller} elapsedMs=${Date.now() - startedAt}`,
          { operation: "voice_transcribe_caller_gone", reqId, caller },
        );
        finish({ kind: "failed", err: callerSignal.reason, provider: backupStarted && backup ? backup : primary });
      };
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    if (opts.deadlineMs !== undefined) {
      const deadlineMs = opts.deadlineMs;
      deadlineTimer = setTimeout(() => {
        deadlineTimer = null;
        if (settled) return;
        databaseLogger.warn(
          `[voice-server] transcribe-deadline reqId=${reqId} caller=${caller} deadlineMs=${deadlineMs} primary=${primary.id} backup=${backupStarted ? backup?.id : "not-started"}`,
          { operation: "voice_transcribe_deadline", reqId, caller, deadlineMs },
        );
        finish({ kind: "failed", err: new SttDeadlineError(deadlineMs), provider: backupStarted && backup ? backup : primary });
      }, deadlineMs);
    }
  });
}
