/**
 * End to end: the real host-side wrappers (each service's bin/ folder:
 * image-gen, agent-phone, stt → substrate/scripts/fleet-service) over HTTP
 * against the real /agent-services router, job store and engine, in a temp
 * HOME. Only the third-party calls (OpenAI, Twilio, the users table) and the
 * credential lookup are faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../utils/logger.js", () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  };
  return {
    systemLogger: stub,
    sshLogger: stub,
    databaseLogger: stub,
    fileLogger: stub,
  };
});
vi.mock("../database/db/index.js", () => ({ getDb: vi.fn() }));

import {
  createAgentServiceEngine,
  type AgentServiceEngine,
} from "./engine/engine.js";
import { createJobStore, type JobStore } from "./engine/jobs.js";
import { createAgentServicesRouter } from "./http/routes.js";
import { createImageGenService } from "./services/image-gen/service.js";
import { createAgentPhoneService } from "./services/agent-phone/service.js";
import { createSttService } from "./services/stt/service.js";
import { groqSttProvider } from "../voice/stt-http-providers.js";
import { z } from "zod";
import { defineService, ok, type ServiceDefinition } from "./engine/types.js";

const SCRIPTS = path.resolve(__dirname, "../../../substrate/scripts");

const CREDENTIAL = "tsc_e2e-machine-one";
const REVOKED = "tsc_e2e-revoked";
const HOST = { id: "1", idNum: 1, machineId: "1" };

let home: string;
let server: Server | null = null;
/** What the router serves; swapped to simulate a backend restart. */
let runtime: {
  engine: AgentServiceEngine;
  jobs: JobStore;
  services: readonly ServiceDefinition[];
} | null = null;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-services-e2e-"));
  fs.mkdirSync(path.join(home, "fleet", "host"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "fleet", "host", "service-credential"),
    `${CREDENTIAL}\n`,
    { mode: 0o600 },
  );
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  runtime = null;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Serve the real router on a local port and point this machine at it. */
async function startBackend(
  engine: AgentServiceEngine,
  services: readonly ServiceDefinition[] = [],
): Promise<void> {
  runtime = { engine, jobs: createJobStore(), services };
  if (server) return;
  const app = express();
  app.use(
    "/agent-services",
    createAgentServicesRouter({
      runtime: () => runtime,
      identifyMachine: async (token) =>
        token === CREDENTIAL
          ? { ok: true, machineId: "1" }
          : { ok: false, reason: token === REVOKED ? "revoked" : "unknown" },
      hostForMachine: async (machineId) => (machineId === "1" ? HOST : null),
    }),
  );
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as AddressInfo;
  fs.writeFileSync(
    path.join(home, "fleet", "host", "parent"),
    `http://127.0.0.1:${port}\n`,
  );
}

function makeEngine(switchedOn: (service: string) => boolean = () => true) {
  const openAi = vi.fn(async () => ({
    ok: true as const,
    images: [Buffer.from("PNG-0"), Buffer.from("PNG-1")],
    generation_time_ms: 5,
  }));
  const transcribe = vi.fn(async () => ({
    kind: "ok" as const,
    text: "first line\nsecond line",
    provider: groqSttProvider,
  }));
  const placeCall = vi.fn(async () => ({
    outcome: "completed" as const,
    transcript: "voice: hello\nuser: got it",
    call_length_seconds: 9,
  }));
  // A per-user-secret service like a future Zoho integration: the backend
  // works out who the agent acts for and hands the handler their key.
  const zohoCalls: Array<{ user: string; token: string }> = [];
  const zoho = defineService({
    name: "zoho",
    title: "Zoho",
    description: "test stand-in for a per-user-key service",
    input: z.strictObject({ query: z.string() }),
    userSecrets: { ZOHO_TOKEN: { label: "Zoho token" } },
    ttlMs: 60_000,
    async handle(input, ctx) {
      zohoCalls.push({
        user: ctx.user!.username,
        token: ctx.userSecrets.ZOHO_TOKEN,
      });
      return ok({ answered: input.query });
    },
  });
  const services = [
    zoho,
    createImageGenService(openAi),
    createSttService({ transcribe }),
    createAgentPhoneService({
      getUserByUsername: async () => ({
        id: "u1",
        phoneE164: "+15555550100",
      }),
      userHasRegisteredHost: async () => true,
      placeCallAndAwait: placeCall,
      sleep: async () => {},
    }),
  ];
  const engine = createAgentServiceEngine({
    resolveActingUser: async (_host, asUser) =>
      asUser === "bob"
        ? { ok: true, user: { id: "u-bob", username: "bob" } }
        : {
            ok: false,
            code: "ambiguous_user",
            message: "say which one with --as",
          },
    loadUserSecret: async (userId) =>
      userId === "u-bob" ? "bob-company-token" : null,
    services,
    // Keys as an admin would have set them in Admin → Services.
    getKey: async (service, name) =>
      ({
        "image-gen/OPENAI_API_KEY": "k",
        "agent-phone/TWILIO_ACCOUNT_SID": "AC1",
        "agent-phone/TWILIO_AUTH_TOKEN": "tok",
        "agent-phone/TWILIO_FROM_NUMBER": "+17165550000",
        "stt/GROQ_API_KEY": "gq",
      })[`${service}/${name}`] ?? null,
    getSettings: async (def) =>
      def.name === "stt"
        ? { provider: "groq", backup: "none", language: "auto" }
        : {},
    isEnabled: async (service) => switchedOn(service),
    createTokenBucket: () => ({
      acquire: async () => {},
      getState: () => ({}) as never,
    }),
  });
  return { engine, services, openAi, placeCall, transcribe, zohoCalls };
}

/** Run a helper on this "machine", against the backend, until it exits. */
async function runHelper(script: string, args: string[], stdin?: string) {
  const scriptPath =
    script === "fleet-service"
      ? path.join(SCRIPTS, script)
      : path.join(__dirname, "services", script, "bin", script);
  const child = spawn(scriptPath, args, {
    env: {
      ...process.env,
      // On a host the wrappers sit next to fleet-service; here they find it
      // on PATH.
      PATH: `${SCRIPTS}:${process.env.PATH ?? ""}`,
      HOME: home,
      IMAGE_GEN_TIMEOUT_SEC: "20",
      AGENT_PHONE_TIMEOUT_SEC: "20",
      STT_TIMEOUT_SEC: "20",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  if (stdin !== undefined) child.stdin.end(stdin);
  else child.stdin.end();
  const code = await new Promise<number>((r) =>
    child.on("exit", (c) => r(c ?? -1)),
  );
  return { code, stdout, stderr };
}

/** Start a backend with fresh fakes, then run one helper against it. */
async function runWithBackend(
  script: string,
  args: string[],
  stdin?: string,
  switchedOn?: (service: string) => boolean,
) {
  const { engine, services, ...fakes } = makeEngine(switchedOn);
  await startBackend(engine, services);
  return { ...(await runHelper(script, args, stdin)), ...fakes };
}

describe("agent services end to end", () => {
  it("a machine the service isn't switched on for is told so, and nothing runs", async () => {
    const r = await runWithBackend(
      "image-gen",
      ["a cat"],
      undefined,
      () => false,
    );
    expect(r.code).not.toBe(0);
    expect(r.openAi).not.toHaveBeenCalled();
    expect(JSON.parse(r.stderr.trim().split("\n").pop()!)).toMatchObject({
      reason: "not_enabled",
      message: expect.stringMatching(/isn't switched on for this machine/),
    });
  });

  it("image-gen: reference image in, two PNGs out", async () => {
    const ref = path.join(home, "base.webp");
    fs.writeFileSync(ref, "REF");
    const r = await runWithBackend("image-gen", [
      "a cat in a hat",
      "--n",
      "2",
      "--ref",
      ref,
    ]);

    expect(r.stderr).not.toMatch(/"reason"/);
    expect(r.code).toBe(0);
    expect(r.openAi).toHaveBeenCalledOnce();
    const [body, refBytes] = r.openAi.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Buffer,
    ];
    expect(body).toMatchObject({ prompt: "a cat in a hat", n: 2 });
    expect(body.ref).toBe("ref.webp");
    expect(refBytes.toString()).toBe("REF");

    const paths = r.stdout.trim().split("\n");
    expect(paths).toHaveLength(2);
    expect(paths.map((p) => fs.readFileSync(p, "utf-8"))).toEqual([
      "PNG-0",
      "PNG-1",
    ]);
    for (const p of paths)
      expect(p.startsWith(path.join(home, "fleet", "image-gen-outputs"))).toBe(
        true,
      );
    expect(JSON.parse(r.stderr.trim())).toMatchObject({
      model: "gpt-image-1.5",
      n: 2,
    });
  }, 30_000);

  it("image-gen: schema failure comes back as malformed", async () => {
    const r = await runWithBackend("image-gen", ["x", "--n", "50"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr.trim())).toMatchObject({
      reason: "malformed",
      message: expect.stringMatching(/^n: /),
    });
    expect(r.openAi).not.toHaveBeenCalled();
  }, 30_000);

  it("agent-phone: message from stdin, transcript out", async () => {
    const message = 'Deploy "prod" failed; $HOME is fine.\nCall back?';
    const r = await runWithBackend(
      "agent-phone",
      ["--to", "alice", "--from", "Clipper", "-"],
      message,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("voice: hello\nuser: got it\n");
    const [call] = r.placeCall.mock.calls[0] as unknown as [
      { openingLine: string },
    ];
    // The call script folds newlines into spaces; everything else survives.
    expect(call.openingLine).toContain(
      'Deploy "prod" failed; $HOME is fine. Call back?',
    );
    expect(JSON.parse(r.stderr.trim())).toMatchObject({
      outcome: "completed",
      call_length_seconds: 9,
    });
  }, 30_000);

  it("stt: audio file in, transcript out", async () => {
    const audio = path.join(home, "memo.M4A");
    fs.writeFileSync(audio, "AUDIO-BYTES");
    const r = await runWithBackend("stt", [audio]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("first line\nsecond line\n");
    const [input] = r.transcribe.mock.calls[0] as unknown as [
      { audio: Buffer; ext: string; mimetype: string },
    ];
    expect(input.audio.toString()).toBe("AUDIO-BYTES");
    expect(input).toMatchObject({ ext: "m4a", mimetype: "audio/mp4" });
    expect(JSON.parse(r.stderr.trim())).toEqual({
      provider: "groq",
      audio_bytes: 11,
      transcription_time_ms: expect.any(Number),
    });
  }, 30_000);

  it("stt: unsupported file type comes back as malformed", async () => {
    const doc = path.join(home, "notes.txt");
    fs.writeFileSync(doc, "not audio");
    const r = await runWithBackend("stt", [doc]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ reason: "malformed" });
    expect(r.transcribe).not.toHaveBeenCalled();
  }, 30_000);

  it("per-user secret: --as picks the user, their key reaches the handler", async () => {
    const r = await runWithBackend("fleet-service", [
      "call",
      "zoho",
      "--as",
      "bob",
      "--input",
      '{"query":"open deals"}',
      "--timeout",
      "20",
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).result).toEqual({ answered: "open deals" });
    expect(r.zohoCalls).toEqual([{ user: "bob", token: "bob-company-token" }]);
    expect(r.stdout).not.toContain("bob-company-token");

    const without = await runWithBackend("fleet-service", [
      "call",
      "zoho",
      "--input",
      '{"query":"x"}',
      "--timeout",
      "20",
    ]);
    expect(without.code).toBe(1);
    expect(JSON.parse(without.stdout).error.code).toBe("ambiguous_user");
  }, 30_000);

  it("fifteen calls in a row each come straight back", async () => {
    const quick = defineService({
      name: "quick",
      title: "Quick",
      description: "test",
      input: z.strictObject({ n: z.number() }),
      ttlMs: 60_000,
      concurrency: 4,
      handle: async (input) => ok({ n: input.n }),
    });
    await startBackend(
      createAgentServiceEngine({
        services: [quick],
        isEnabled: async () => true,
        getKey: async () => null,
        getSettings: async () => ({}),
      }),
    );
    const started = Date.now();
    for (let n = 0; n < 15; n++) {
      const r = await runHelper("fleet-service", [
        "call",
        "quick",
        "--input",
        JSON.stringify({ n }),
        "--timeout",
        "20",
      ]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).result).toEqual({ n });
    }
    // The file drop took ~5s a call; a direct call is a fraction of a second,
    // most of it starting curl and jq.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  /** A service whose one job finishes when `finish` is called. */
  function gated() {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const handle = vi.fn(async () => {
      await gate;
      return ok({ done: true });
    });
    const slow = defineService({
      name: "slow",
      title: "Slow",
      description: "test",
      input: z.strictObject({}),
      ttlMs: 60_000,
      handle,
    });
    const engine = () =>
      createAgentServiceEngine({
        services: [slow],
        isEnabled: async () => true,
        getKey: async () => null,
        getSettings: async () => ({}),
      });
    return { engine, handle, finish: () => finish() };
  }

  it("a long job outlives its caller; collect gets the answer, and the work ran once", async () => {
    const g = gated();
    await startBackend(g.engine());
    const id = "4f1d7a3c-2b9e-4c51-8d6a-0e9b7c5a3f21";
    // A one-second budget runs out while the job is still going.
    const first = await runHelper("fleet-service", [
      "call",
      "slow",
      "--id",
      id,
      "--timeout",
      "1",
    ]);
    expect(first.code).toBe(1);
    expect(JSON.parse(first.stdout).error).toMatchObject({
      code: "timeout",
      message: expect.stringContaining(`fleet-service collect ${id}`),
    });
    g.finish();
    const second = await runHelper("fleet-service", [
      "collect",
      id,
      "--timeout",
      "10",
    ]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).result).toEqual({ done: true });
    expect(g.handle).toHaveBeenCalledTimes(1);
    // Collected: the backend has let it go.
    const again = await runHelper("fleet-service", [
      "collect",
      id,
      "--timeout",
      "10",
    ]);
    expect(JSON.parse(again.stdout).error.code).toBe("lost");
  }, 30_000);

  it("after a backend restart, collect reports the job lost and nothing runs again", async () => {
    const before = gated();
    await startBackend(before.engine());
    const id = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    await runHelper("fleet-service", [
      "call",
      "slow",
      "--id",
      id,
      "--timeout",
      "1",
    ]);
    // Restart: a new process with no record of the job.
    const after = gated();
    await startBackend(after.engine());
    const r = await runHelper("fleet-service", [
      "collect",
      id,
      "--timeout",
      "10",
    ]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "lost",
      message: expect.stringMatching(/restarted.*not run again/),
    });
    expect(after.handle).not.toHaveBeenCalled();
    before.finish();
  }, 30_000);

  it("a revoked machine is told an admin revoked it; an unknown credential is refused", async () => {
    const { engine, services, openAi } = makeEngine();
    await startBackend(engine, services);
    const cred = path.join(home, "fleet", "host", "service-credential");
    fs.writeFileSync(cred, `${REVOKED}\n`);
    const revoked = await runHelper("fleet-service", [
      "call",
      "image-gen",
      "--input",
      '{"prompt":"x"}',
      "--timeout",
      "10",
    ]);
    expect(revoked.code).toBe(1);
    expect(JSON.parse(revoked.stdout).error).toMatchObject({
      code: "revoked",
      message: expect.stringMatching(/an admin revoked this machine's access/),
    });
    fs.writeFileSync(cred, "tsc_forged\n");
    const forged = await runHelper("fleet-service", [
      "call",
      "image-gen",
      "--input",
      '{"prompt":"x"}',
      "--timeout",
      "10",
    ]);
    expect(JSON.parse(forged.stdout).error.code).toBe("unauthorized");
    expect(openAi).not.toHaveBeenCalled();
  }, 30_000);

  it("an attachment for a slot the service doesn't have is refused before it's taken in", async () => {
    const { engine, services, transcribe } = makeEngine();
    await startBackend(engine, services);
    const audio = path.join(home, "memo.ogg");
    fs.writeFileSync(audio, "AUDIO");
    const r = await runHelper("fleet-service", [
      "call",
      "stt",
      "--attach",
      `other=${audio}`,
      "--timeout",
      "10",
    ]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: "malformed",
      message: "unexpected attachment: other",
    });
    expect(transcribe).not.toHaveBeenCalled();
  }, 30_000);
});
