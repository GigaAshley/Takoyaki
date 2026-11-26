import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Bedrock provider pulls in the AWS SDK client singleton at import time;
// stub it so this suite stays a pure unit test.
vi.mock("./nova-sonic-adapter.js", () => ({ transcribeNovaSonic: vi.fn() }));

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ databaseLogger: log, systemLogger: log, sshLogger: log }));

import {
  clearSttFallbackWarnings,
  isSttQuotaExhausted,
  resolveSttFallback,
  resolveSttProvider,
  STT_PROVIDER_IDS,
  transcribeWithFallback,
  type SttProvider,
  sttHedgeDelayMs,
  transcribeWithRetries,
} from "./stt-provider.js";
import { SttDeadlineError, SttHttpError, SttNetworkError, SttNotConfiguredError } from "./stt-errors.js";
import {
  elevenLabsSttProvider,
  groqSttProvider,
  mistralSttProvider,
} from "./stt-http-providers.js";
import { bedrockSttProvider } from "./stt-bedrock.js";

const INPUT = { audio: Buffer.from("fake webm"), mimetype: "audio/webm;codecs=opus", ext: "webm" };

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveSttProvider", () => {
  it("defaults to bedrock when STT_PROVIDER is unset or blank", () => {
    expect(resolveSttProvider({}).id).toBe("bedrock");
    expect(resolveSttProvider({ STT_PROVIDER: "  " }).id).toBe("bedrock");
  });

  it.each(STT_PROVIDER_IDS)("selects %s (case/whitespace-insensitive)", (id) => {
    expect(resolveSttProvider({ STT_PROVIDER: ` ${id.toUpperCase()} ` }).id).toBe(id);
  });

  it("throws SttNotConfiguredError for an unknown provider instead of falling back", () => {
    expect(() => resolveSttProvider({ STT_PROVIDER: "whisperx" })).toThrow(SttNotConfiguredError);
  });
});

describe("HTTP STT providers", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delete process.env.STT_MODEL;
    delete process.env.STT_LANGUAGE;
    process.env.ELEVENLABS_API_KEY = "el-key";
    process.env.MISTRAL_API_KEY = "mi-key";
    process.env.GROQ_API_KEY = "gq-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
  });

  function lastRequest(): { url: string; headers: Record<string, string>; form: FormData } {
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    return {
      url: String(url),
      headers: init!.headers as Record<string, string>,
      form: init!.body as FormData,
    };
  }

  it("elevenlabs: posts to /v1/speech-to-text with xi-api-key, scribe_v2, audio tags off", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ text: " hello there ", words: [] }));

    await expect(elevenLabsSttProvider.transcribe(INPUT)).resolves.toBe("hello there");

    const { url, headers, form } = lastRequest();
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(headers).toEqual({ "xi-api-key": "el-key" });
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("tag_audio_events")).toBe("false");
    expect(form.has("language_code")).toBe(false);
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.webm");
    expect(file.type).toBe("audio/webm;codecs=opus");
    expect(Buffer.from(await file.arrayBuffer()).equals(INPUT.audio)).toBe(true);
  });

  it("mistral: posts to /v1/audio/transcriptions with Bearer auth and voxtral-mini-latest", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ text: "voxtral says hi" }));

    await expect(mistralSttProvider.transcribe(INPUT)).resolves.toBe("voxtral says hi");

    const { url, headers, form } = lastRequest();
    expect(url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(headers).toEqual({ Authorization: "Bearer mi-key" });
    expect(form.get("model")).toBe("voxtral-mini-latest");
  });

  it("groq: posts to the OpenAI-compatible endpoint with whisper-large-v3-turbo, temp 0", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ text: "whisper says hi" }));

    await expect(groqSttProvider.transcribe(INPUT)).resolves.toBe("whisper says hi");

    const { url, headers, form } = lastRequest();
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(headers).toEqual({ Authorization: "Bearer gq-key" });
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("temperature")).toBe("0");
    expect(form.get("response_format")).toBe("json");
  });

  it("STT_MODEL overrides the SELECTED provider's model only; STT_LANGUAGE pins every provider", async () => {
    process.env.STT_PROVIDER = "elevenlabs";
    process.env.STT_MODEL = "scribe_v9";
    process.env.STT_LANGUAGE = "en";
    fetchMock.mockImplementation(async () => okJson({ text: "x" }));

    await elevenLabsSttProvider.transcribe(INPUT);
    expect(lastRequest().form.get("model_id")).toBe("scribe_v9");
    expect(lastRequest().form.get("language_code")).toBe("en");

    // A backup never gets the selected provider's model id.
    await groqSttProvider.transcribe(INPUT);
    expect(lastRequest().form.get("model")).toBe("whisper-large-v3-turbo");
    expect(lastRequest().form.get("language")).toBe("en");
  });

  it("a per-request language overrides STT_LANGUAGE", async () => {
    process.env.STT_LANGUAGE = "fr";
    fetchMock.mockImplementation(async () => okJson({ text: "x" }));

    await elevenLabsSttProvider.transcribe({ ...INPUT, language: "en" });
    expect(lastRequest().form.get("language_code")).toBe("en");

    await groqSttProvider.transcribe({ ...INPUT, language: "en" });
    expect(lastRequest().form.get("language")).toBe("en");

    await groqSttProvider.transcribe(INPUT);
    expect(lastRequest().form.get("language")).toBe("fr");
  });

  it("missing API key → SttNotConfiguredError (unavailable), and no request is sent", async () => {
    delete process.env.GROQ_API_KEY;

    const err = await groqSttProvider.transcribe(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SttNotConfiguredError);
    expect(groqSttProvider.isUnavailable(err)).toBe(true);
    expect(groqSttProvider.isRetriable(err)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("non-2xx → SttHttpError carrying status and a truncated body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(2000), { status: 400 }));

    const err = await mistralSttProvider.transcribe(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SttHttpError);
    expect((err as SttHttpError).status).toBe(400);
    expect((err as SttHttpError).body.length).toBe(500);
  });

  it("fetch rejection (DNS/socket/timeout) → SttNetworkError, retriable", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "TimeoutError" }));

    const err = await groqSttProvider.transcribe(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SttNetworkError);
    expect(groqSttProvider.isRetriable(err)).toBe(true);
  });

  it("response without a text field is an error, not an empty transcript", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ transcript: "wrong shape" }));
    await expect(groqSttProvider.transcribe(INPUT)).rejects.toThrow(/missing "text"/);
  });

  it.each([
    [new SttHttpError("groq", 429, ""), true, false],
    [new SttHttpError("groq", 503, ""), true, false],
    [new SttHttpError("groq", 400, ""), false, false],
    [new SttHttpError("groq", 401, ""), false, true],
    [new SttHttpError("groq", 402, ""), false, true],
    [new SttHttpError("groq", 403, ""), false, true],
    // Out of credit reported as 429: retrying can't help.
    [new SttHttpError("elevenlabs", 429, '{"detail":{"status":"quota_exceeded"}}'), false, true],
    [new SttHttpError("groq", 429, '{"error":{"code":"insufficient_quota"}}'), false, true],
    [new SttNetworkError("groq", new TypeError("fetch failed")), true, false],
    [new TypeError("not from fetch"), false, false],
    [new Error("boom"), false, false],
  ])("classifies %o → retriable=%s unavailable=%s", (err, retriable, unavailable) => {
    expect(groqSttProvider.isRetriable(err)).toBe(retriable);
    expect(groqSttProvider.isUnavailable(err)).toBe(unavailable);
  });
});

describe("bedrock provider error classification", () => {
  it.each([
    ["ModelStreamErrorException", true],
    ["ThrottlingException", true],
    ["ValidationException", false],
  ])("%s → retriable=%s", (name, retriable) => {
    expect(bedrockSttProvider.isRetriable(Object.assign(new Error(), { name }))).toBe(retriable);
  });

  it("AccessDeniedException → unavailable", () => {
    const err = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    expect(bedrockSttProvider.isUnavailable(err)).toBe(true);
  });
});

describe("resolveSttFallback", () => {
  it("unset, blank or none → no backup", () => {
    expect(resolveSttFallback({})).toEqual({ kind: "none" });
    expect(resolveSttFallback({ STT_FALLBACK_PROVIDER: "  " })).toEqual({ kind: "none" });
    expect(resolveSttFallback({ STT_FALLBACK_PROVIDER: "None" })).toEqual({ kind: "none" });
  });

  it("selects a known provider (case/whitespace-insensitive)", () => {
    const fb = resolveSttFallback({ STT_PROVIDER: "elevenlabs", STT_FALLBACK_PROVIDER: " GROQ " });
    expect(fb.kind === "ok" && fb.provider.id).toBe("groq");
  });

  it("bedrock may be the backup of an HTTP provider", () => {
    const fb = resolveSttFallback({ STT_PROVIDER: "groq", STT_FALLBACK_PROVIDER: "bedrock" });
    expect(fb.kind === "ok" && fb.provider.id).toBe("bedrock");
  });

  it("an unknown value is ignored, never mapped to another provider", () => {
    expect(resolveSttFallback({ STT_FALLBACK_PROVIDER: "whisper" })).toEqual({ kind: "ignored", raw: "whisper", reason: "unknown" });
  });

  it("the selected provider again is ignored (default bedrock counts)", () => {
    expect(resolveSttFallback({ STT_PROVIDER: "groq", STT_FALLBACK_PROVIDER: "groq" })).toMatchObject({ kind: "ignored", reason: "same-as-primary" });
    expect(resolveSttFallback({ STT_FALLBACK_PROVIDER: "bedrock" })).toMatchObject({ kind: "ignored", reason: "same-as-primary" });
  });
});

describe("isSttQuotaExhausted", () => {
  it("matches a quota body on an HTTP error only", () => {
    expect(isSttQuotaExhausted(new SttHttpError("elevenlabs", 401, '{"detail":{"status":"quota_exceeded"}}'))).toBe(true);
    expect(isSttQuotaExhausted(new SttHttpError("elevenlabs", 401, "invalid key"))).toBe(false);
    expect(isSttQuotaExhausted(new Error("quota"))).toBe(false);
  });
});

describe("transcribeWithFallback", () => {
  const ENV = { STT_PROVIDER: "elevenlabs", STT_FALLBACK_PROVIDER: "groq" };
  const QUOTA = new SttHttpError("elevenlabs", 401, '{"detail":{"status":"quota_exceeded"}}');

  beforeEach(() => {
    log.info.mockClear();
    log.warn.mockClear();
    clearSttFallbackWarnings();
  });

  /** Fake per-provider turn: each provider id maps to a text or an error. */
  function attemptWith(results: Record<string, string | Error>) {
    return vi.fn(async (p: SttProvider, _input: unknown, _max: number) => {
      const r = results[p.id];
      if (r instanceof Error) throw r;
      return r;
    });
  }

  function warnLines(): string[] {
    return log.warn.mock.calls.map((c) => String(c[0]));
  }

  it("primary succeeds → backup never called", async () => {
    const attempt = attemptWith({ elevenlabs: "hello", groq: new Error("unused") });
    const r = await transcribeWithFallback(INPUT, { caller: "test", env: ENV, attempt });
    expect(r).toMatchObject({ kind: "ok", text: "hello", provider: { id: "elevenlabs" } });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(warnLines()).toEqual([]);
  });

  it("primary out of credit → same recording goes to the backup, with a switch log line", async () => {
    const attempt = attemptWith({ elevenlabs: QUOTA, groq: "from groq" });
    const r = await transcribeWithFallback(INPUT, { reqId: "abc123", caller: "transcribe", env: ENV, attempt, maxAttempts: 2 });

    expect(r).toMatchObject({ kind: "ok", text: "from groq", provider: { id: "groq" } });
    expect(attempt.mock.calls.map((c) => [c[0].id, c[1], c[2]])).toEqual([
      // The providers read their keys from the same setup.
      ["elevenlabs", { ...INPUT, env: ENV, signal: expect.any(AbortSignal) }, 2],
      ["groq", { ...INPUT, env: ENV, signal: expect.any(AbortSignal) }, 2],
    ]);
    const line = warnLines().find((l) => l.includes("transcribe-fallback "));
    expect(line).toMatch(/reqId=abc123 caller=transcribe from=elevenlabs to=groq reason=quota/);
    expect(log.info.mock.calls.some((c) => /transcribe-fallback-ok reqId=abc123 .*from=elevenlabs to=groq/.test(String(c[0])))).toBe(true);
  });

  it.each([
    ["auth", new SttHttpError("elevenlabs", 401, "invalid api key"), "unavailable"],
    ["5xx after retries", new SttHttpError("elevenlabs", 503, ""), "retries-exhausted"],
    ["timeout after retries", new SttNetworkError("elevenlabs", new Error("timeout")), "retries-exhausted"],
    ["bad audio", new SttHttpError("elevenlabs", 400, "bad file"), "error"],
    ["anything else", new Error("boom"), "error"],
  ])("any primary failure (%s) falls back, reason=%s", async (_n, err, reason) => {
    const attempt = attemptWith({ elevenlabs: err, groq: "ok" });
    const r = await transcribeWithFallback(INPUT, { caller: "t", env: ENV, attempt });
    expect(r).toMatchObject({ kind: "ok", provider: { id: "groq" } });
    expect(warnLines().some((l) => l.includes(`reason=${reason} `))).toBe(true);
  });

  it("a rate-limit 429 that mentions quota is retries-exhausted, not quota", async () => {
    const rateLimit = new SttHttpError("elevenlabs", 429, '{"error":"rate limit: requests per minute quota"}');
    const attempt = attemptWith({ elevenlabs: rateLimit, groq: "ok" });
    await transcribeWithFallback(INPUT, { caller: "t", env: ENV, attempt });
    expect(warnLines().some((l) => l.includes("reason=retries-exhausted "))).toBe(true);
  });

  it("both fail → the backup's error and provider, both failures logged", async () => {
    const backupErr = new SttNetworkError("groq", new Error("down"));
    const attempt = attemptWith({ elevenlabs: QUOTA, groq: backupErr });
    const r = await transcribeWithFallback(INPUT, { reqId: "r1", caller: "t", env: ENV, attempt });

    expect(r).toEqual({ kind: "failed", err: backupErr, provider: expect.objectContaining({ id: "groq" }) });
    expect(warnLines().some((l) => /transcribe-fallback reqId=r1 .*reason=quota/.test(l))).toBe(true);
    expect(warnLines().some((l) => /transcribe-fallback-failed reqId=r1 .*to=groq reason=retries-exhausted/.test(l))).toBe(true);
  });

  it("no backup configured → exactly the primary's outcome, no fallback lines", async () => {
    const attempt = attemptWith({ elevenlabs: QUOTA });
    const r = await transcribeWithFallback(INPUT, { caller: "t", env: { STT_PROVIDER: "elevenlabs" }, attempt });
    expect(r).toEqual({ kind: "failed", err: QUOTA, provider: expect.objectContaining({ id: "elevenlabs" }) });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(warnLines()).toEqual([]);
  });

  it("ignored backup setting → no backup used, warned once", async () => {
    const attempt = attemptWith({ elevenlabs: QUOTA });
    const env = { STT_PROVIDER: "elevenlabs", STT_FALLBACK_PROVIDER: "whisper" };
    await transcribeWithFallback(INPUT, { caller: "t", env, attempt });
    await transcribeWithFallback(INPUT, { caller: "t", env, attempt });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls.every((c) => c[0].id === "elevenlabs")).toBe(true);
    expect(warnLines().filter((l) => l.includes("transcribe-fallback-config-ignored"))).toEqual([
      '[voice-server] transcribe-fallback-config-ignored value="whisper" reason=unknown',
    ]);
  });

  it("invalid STT_PROVIDER → not-configured error, the backup is not used", async () => {
    const attempt = attemptWith({ groq: "should not run" });
    const r = await transcribeWithFallback(INPUT, { caller: "t", env: { STT_PROVIDER: "nope", STT_FALLBACK_PROVIDER: "groq" }, attempt });
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.err).toBeInstanceOf(SttNotConfiguredError);
    expect(r.provider).toBeUndefined();
    expect(attempt).not.toHaveBeenCalled();
  });

  it("every call starts with the primary (no memory of earlier failures)", async () => {
    const attempt = attemptWith({ elevenlabs: QUOTA, groq: "ok" });
    await transcribeWithFallback(INPUT, { caller: "t", env: ENV, attempt });
    await transcribeWithFallback(INPUT, { caller: "t", env: ENV, attempt });
    expect(attempt.mock.calls.map((c) => c[0].id)).toEqual(["elevenlabs", "groq", "elevenlabs", "groq"]);
  });

  it("by default runs each provider through its own retries", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const saved = { ...process.env };
    // A caller's own setup: keys come from it, not the server settings.
    const env = { ...ENV, ELEVENLABS_API_KEY: "el", GROQ_API_KEY: "gq" };
    try {
      // elevenlabs: 503 three times (retried), groq: success.
      fetchMock
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(okJson({ text: " backup text " }));
      vi.useFakeTimers();
      const p = transcribeWithFallback(INPUT, { caller: "t", env });
      await vi.runAllTimersAsync();
      const r = await p;
      expect(r).toMatchObject({ kind: "ok", text: "backup text", provider: { id: "groq" } });
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
        "https://api.elevenlabs.io/v1/speech-to-text",
        "https://api.elevenlabs.io/v1/speech-to-text",
        "https://api.elevenlabs.io/v1/speech-to-text",
        "https://api.groq.com/openai/v1/audio/transcriptions",
      ]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      process.env = saved;
    }
  });
});

describe("transcribeWithFallback — slow selected provider", () => {
  const ENV = { STT_PROVIDER: "elevenlabs", STT_FALLBACK_PROVIDER: "groq" };

  beforeEach(() => {
    log.info.mockClear();
    log.warn.mockClear();
    clearSttFallbackWarnings();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A provider turn that settles when the test says so; records its cancel signal. */
  function controllable() {
    const turns = new Map<string, { resolve: (t: string) => void; reject: (e: unknown) => void; signal: AbortSignal | undefined }>();
    const attempt = vi.fn(
      (p: SttProvider, input: { signal?: AbortSignal }) =>
        new Promise<string>((resolve, reject) => {
          turns.set(p.id, { resolve, reject, signal: input.signal });
        }),
    );
    return { attempt, turns };
  }
  const settledWith = async <T,>(p: Promise<T>) => {
    let out: T | undefined;
    void p.then((v) => (out = v));
    await vi.advanceTimersByTimeAsync(0);
    return () => out;
  };
  const warnLines = () => log.warn.mock.calls.map((c) => String(c[0]));
  const infoLines = () => log.info.mock.calls.map((c) => String(c[0]));

  it("hedge delay: 10 s plus 3 s per minute of audio, from the given length or the byte size", () => {
    expect(sttHedgeDelayMs({ audio: Buffer.alloc(0), durationMs: 0 })).toBe(10_000);
    expect(sttHedgeDelayMs({ audio: Buffer.alloc(0), durationMs: 5 * 60_000 })).toBe(25_000);
    // No length given: guessed at ~4 kB per second (errs long) → 60 s here.
    expect(sttHedgeDelayMs({ audio: Buffer.alloc(4_000 * 60) })).toBe(13_000);
    // A provider that can't go faster than N s per minute gets that on top.
    expect(sttHedgeDelayMs({ audio: Buffer.alloc(0), durationMs: 5 * 60_000 }, { minMsPerAudioMinute: 15_000 })).toBe(100_000);
  });

  it("Bedrock as the selected provider: a healthy 5-minute piece is not raced (its pace floor counts)", async () => {
    const { attempt } = controllable();
    void transcribeWithFallback({ ...INPUT, durationMs: 5 * 60_000 }, { caller: "transcribe", env: { STT_PROVIDER: "bedrock", STT_FALLBACK_PROVIDER: "groq" }, attempt });
    await vi.advanceTimersByTimeAsync(99_999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("the caller going away cancels everything and ends the wait", async () => {
    const { attempt, turns } = controllable();
    const gone = new AbortController();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 0 }, { caller: "transcribe", env: ENV, attempt, signal: gone.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    gone.abort(new Error("client disconnected"));
    const r = await p;
    expect(r.kind).toBe("failed");
    expect(turns.get("elevenlabs")!.signal?.aborted).toBe(true);
    expect(turns.get("groq")!.signal?.aborted).toBe(true);
  });

  it("no answer by the hedge delay → the backup is asked too; the backup's answer wins and the selected one is cancelled", async () => {
    const { attempt, turns } = controllable();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 60_000 }, { reqId: "h1", caller: "transcribe", env: ENV, attempt });
    await vi.advanceTimersByTimeAsync(12_999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(warnLines().some((l) => /transcribe-hedge reqId=h1 caller=transcribe from=elevenlabs to=groq afterMs=13000 reason=slow/.test(l))).toBe(true);

    turns.get("groq")!.resolve("from groq");
    const r = await p;
    expect(r).toMatchObject({ kind: "ok", text: "from groq", provider: { id: "groq" } });
    expect(turns.get("elevenlabs")!.signal?.aborted).toBe(true);
    expect(infoLines().some((l) => /transcribe-fallback-ok reqId=h1 .*primaryFailed=false/.test(l))).toBe(true);
  });

  it("the selected provider answering after the backup was asked still wins, and the backup is cancelled", async () => {
    const { attempt, turns } = controllable();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 0 }, { reqId: "h2", caller: "transcribe", env: ENV, attempt });
    await vi.advanceTimersByTimeAsync(10_000);
    turns.get("elevenlabs")!.resolve("from elevenlabs");
    const r = await p;
    expect(r).toMatchObject({ kind: "ok", text: "from elevenlabs", provider: { id: "elevenlabs" } });
    expect(turns.get("groq")!.signal?.aborted).toBe(true);
    expect(infoLines().some((l) => /transcribe-hedge-primary-won reqId=h2 /.test(l))).toBe(true);
    // A late answer from the loser changes nothing.
    turns.get("groq")!.resolve("late");
    expect(await p).toMatchObject({ text: "from elevenlabs" });
  });

  it("a fast answer never asks the backup", async () => {
    const { attempt, turns } = controllable();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 0 }, { caller: "transcribe", env: ENV, attempt });
    await vi.advanceTimersByTimeAsync(2_000);
    turns.get("elevenlabs")!.resolve("quick");
    expect(await p).toMatchObject({ kind: "ok", text: "quick" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("the early backup failing leaves the selected provider running; it can still win", async () => {
    const { attempt, turns } = controllable();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 0 }, { reqId: "h3", caller: "transcribe", env: ENV, attempt });
    await vi.advanceTimersByTimeAsync(10_000);
    turns.get("groq")!.reject(new Error("groq down"));
    const get = await settledWith(p);
    expect(get()).toBeUndefined();
    expect(warnLines().some((l) => /transcribe-hedge-backup-failed reqId=h3 /.test(l))).toBe(true);
    turns.get("elevenlabs")!.resolve("got there");
    expect(await p).toMatchObject({ kind: "ok", text: "got there", provider: { id: "elevenlabs" } });
  });

  it("both fail (in either order) → the backup's error", async () => {
    const { attempt, turns } = controllable();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 0 }, { caller: "transcribe", env: ENV, attempt });
    await vi.advanceTimersByTimeAsync(10_000);
    const groqErr = new Error("groq down");
    turns.get("groq")!.reject(groqErr);
    await vi.advanceTimersByTimeAsync(0);
    turns.get("elevenlabs")!.reject(new Error("el down"));
    expect(await p).toMatchObject({ kind: "failed", err: groqErr, provider: { id: "groq" } });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("the selected provider failing after the backup was asked early waits for the backup (no second backup)", async () => {
    const { attempt, turns } = controllable();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 0 }, { caller: "transcribe", env: ENV, attempt });
    await vi.advanceTimersByTimeAsync(10_000);
    turns.get("elevenlabs")!.reject(new Error("el down"));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(2);
    turns.get("groq")!.resolve("rescued");
    expect(await p).toMatchObject({ kind: "ok", text: "rescued", provider: { id: "groq" } });
  });

  it("deadline → SttDeadlineError, everything still running is cancelled", async () => {
    const { attempt, turns } = controllable();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 0 }, { reqId: "d1", caller: "transcribe", env: ENV, attempt, deadlineMs: 180_000 });
    await vi.advanceTimersByTimeAsync(179_999);
    const get = await settledWith(p);
    expect(get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.kind).toBe("failed");
    expect((r as { err: unknown }).err).toBeInstanceOf(SttDeadlineError);
    expect(turns.get("elevenlabs")!.signal?.aborted).toBe(true);
    expect(turns.get("groq")!.signal?.aborted).toBe(true);
    expect(warnLines().some((l) => /transcribe-deadline reqId=d1 caller=transcribe deadlineMs=180000/.test(l))).toBe(true);
  });

  it("no backup configured: never hedges, and the deadline still applies", async () => {
    const { attempt } = controllable();
    const p = transcribeWithFallback({ ...INPUT, durationMs: 0 }, { caller: "transcribe", env: { STT_PROVIDER: "elevenlabs" }, attempt, deadlineMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ kind: "failed", provider: { id: "elevenlabs" } });
  });
});

describe("transcribeWithRetries — cancelled", () => {
  it("a cancel during the pause between tries ends it at once, without another try", async () => {
    vi.useFakeTimers();
    try {
      const ctl = new AbortController();
      const transcribe = vi.fn(async () => {
        throw new SttNetworkError("groq", new Error("timeout"));
      });
      const provider = { ...groqSttProvider, transcribe };
      const p = transcribeWithRetries(provider, { ...INPUT, signal: ctl.signal }, 3);
      const settled = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100); // inside the 500 ms pause
      ctl.abort(new Error("lost the race"));
      expect(await settled).toMatchObject({ message: "lost the race" });
      expect(transcribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying once the caller cancels", async () => {
    const ctl = new AbortController();
    const transcribe = vi.fn(async () => {
      ctl.abort();
      throw new SttNetworkError("groq", new Error("aborted"));
    });
    const provider = { ...groqSttProvider, transcribe };
    await expect(transcribeWithRetries(provider, { ...INPUT, signal: ctl.signal }, 3)).rejects.toBeInstanceOf(SttNetworkError);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

describe("HTTP STT providers — cancel signal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("a caller's cancel aborts the in-flight request", async () => {
    const saved = { ...process.env };
    process.env.GROQ_API_KEY = "gq";
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          seen?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }),
    );
    try {
      const ctl = new AbortController();
      const p = groqSttProvider.transcribe({ ...INPUT, signal: ctl.signal });
      ctl.abort();
      await expect(p).rejects.toBeInstanceOf(SttNetworkError);
      expect(seen?.aborted).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});
