import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("../../utils/logger.js", () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  };
  return { systemLogger: stub, sshLogger: stub };
});

import { createAgentServiceEngine, type EngineDeps } from "./engine.js";
import type { IncomingRequest } from "./protocol.js";
import { defineService, fail, ok, type ServiceDefinition } from "./types.js";

const UUID = "0b5c2f9e-1a2b-4c3d-8e9f-001122334455";
const HOST = { id: "7", idNum: 7, machineId: "m7" };
const NOW = Date.parse("2026-10-08T12:00:00Z");

/** Store-backed deps: keys "service/NAME", settings per service, grants "service@machine". */
function storeDeps(opts: {
  keys?: Record<string, string>;
  settings?: Record<string, Record<string, string>>;
  /** Default: every service on for every machine. */
  grants?: string[];
}) {
  return {
    isEnabled: async (service: string, machineId: string) =>
      opts.grants ? opts.grants.includes(`${service}@${machineId}`) : true,
    getKey: async (service: string, name: string) => opts.keys?.[`${service}/${name}`] ?? null,
    getSettings: async (def: ServiceDefinition) => {
      const out: Record<string, string> = {};
      for (const [name, spec] of Object.entries(def.settings ?? {})) {
        out[name] = opts.settings?.[def.name]?.[name] ?? spec.default ?? "";
      }
      return out;
    },
  };
}

type Attachments = IncomingRequest["attachments"];

/** A request as the router hands it over, from envelope-shaped fields. */
function request(
  body: { service: string; input: unknown; as_user?: string },
  attachments: Attachments = {},
  id = UUID,
): IncomingRequest {
  return {
    id,
    service: body.service,
    input: body.input,
    ...(body.as_user !== undefined ? { asUser: body.as_user } : {}),
    attachments,
  };
}

function setup(
  services: ServiceDefinition[],
  opts: {
    keys?: Record<string, string>;
    settings?: Record<string, Record<string, string>>;
    grants?: string[];
    coreHandlers?: ServiceDefinition[];
    recordUsage?: EngineDeps["recordUsage"];
    now?: () => number;
    resolveActingUser?: EngineDeps["resolveActingUser"];
    loadUserSecret?: EngineDeps["loadUserSecret"];
  } = {},
) {
  const engine = createAgentServiceEngine({
    services,
    coreHandlers: opts.coreHandlers,
    ...storeDeps(opts),
    recordUsage: opts.recordUsage,
    now: opts.now ?? (() => NOW),
    resolveActingUser: opts.resolveActingUser,
    loadUserSecret: opts.loadUserSecret,
  });
  /** Submit one request and wait for its answer. */
  const submit = async (
    body: { service: string; input: unknown; as_user?: string },
    attachments?: Attachments,
  ) => {
    const a = await engine.submit(HOST, request(body, attachments));
    return { response: a.body as Record<string, any>, files: a.files };
  };
  return { engine, submit };
}

const echo = defineService({
  name: "echo",
  title: "Echo",
  description: "test",
  input: z.strictObject({ text: z.string().min(1) }),
  ttlMs: 60_000,
  async handle(input, ctx) {
    return ok({ text: input.text, host: ctx.host.idNum });
  },
});

const envelope = (input: unknown, extra: Record<string, unknown> = {}) => ({
  service: "echo",
  input,
  ...extra,
});

describe("agent-services engine", () => {
  it("runs the handler as the requesting host and answers", async () => {
    const { submit } = setup([echo]);
    const w = await submit(envelope({ text: "hi" }));
    expect(w.response).toEqual({
      ok: true,
      service: "echo",
      result: { text: "hi", host: 7 },
      files: [],
    });
  });

  it("hands back output files and lists their types and sizes", async () => {
    const svc = defineService({
      ...echo,
      handle: async () =>
        ok({}, [
          { ext: "png", bytes: Buffer.from("a") },
          { ext: "txt", bytes: Buffer.from("b") },
        ]),
    });
    const w = await setup([svc]).submit(envelope({ text: "x" }));
    expect(w.files.map((f) => f.bytes.toString())).toEqual(["a", "b"]);
    expect(w.response.files).toEqual([
      { ext: "png", size: 1 },
      { ext: "txt", size: 1 },
    ]);
  });

  it("passes service failures through with details merged", async () => {
    const svc = defineService({
      ...echo,
      handle: async () => fail("busy", "line busy", { seconds: 4 }),
    });
    const w = await setup([svc]).submit(envelope({ text: "x" }));
    expect(w.response).toEqual({
      ok: false,
      service: "echo",
      error: { code: "busy", message: "line busy", seconds: 4 },
    });
  });

  it("answers an unknown service without running anything", async () => {
    const w = await setup([echo]).submit({ ...envelope({}), service: "nope" });
    expect(w.response.ok).toBe(false);
    expect(w.response.service).toBe("nope");
    expect(w.response.error.code).toBe("unknown_service");
    expect(w.response.error.message).toMatch(/no agent service named "nope"/);
  });

  it("rejects input that fails the schema, naming the field", async () => {
    const handle = vi.fn();
    const w = await setup([{ ...echo, handle }]).submit(envelope({ text: "" }));
    expect(w.response.error.code).toBe("malformed");
    expect(w.response.error.message).toMatch(/^text: /);
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects unknown input fields via strictObject", async () => {
    const w = await setup([echo]).submit(envelope({ text: "x", txet: "typo" }));
    expect(w.response.error.code).toBe("malformed");
    expect(w.response.error.message).toMatch(/txet/);
  });

  it("answers expired when dequeued past the TTL, counted from arrival", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let clock = NOW;
    const handle = vi.fn(async (input: { text: string }) => {
      if (input.text === "first") await gate;
      return ok({});
    });
    const { engine } = setup([{ ...echo, handle }], { now: () => clock });
    const first = engine.submit(HOST, request(envelope({ text: "first" })));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    const second = engine.submit(HOST, request(envelope({ text: "second" }), {}, "bbbbbbbb-1111-4111-8111-111111111111"));
    // Wait until the second is queued behind the first, then let time pass.
    await new Promise((r) => setTimeout(r, 0));
    clock = NOW + 120_000;
    release();
    await first;
    expect((await second).body).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("answers not_configured when a declared secret is unset, and passes it when set", async () => {
    const seen: Record<string, string>[] = [];
    const svc = defineService({
      ...echo,
      secrets: { API_KEY: { label: "API key", description: "test" } },
      handle: async (_i, ctx) => {
        seen.push(ctx.secrets);
        return ok({});
      },
    });
    const missing = await setup([svc]).submit(envelope({ text: "x" }));
    expect(missing.response.error).toEqual({
      code: "not_configured",
      message:
        "echo isn't set up yet: it needs its API key; an admin can set it up in Admin → Services",
    });
    await setup([svc], { keys: { "echo/API_KEY": "k" } }).submit(
      envelope({ text: "x" }),
    );
    expect(seen).toEqual([{ API_KEY: "k" }]);
  });

  it("never reads a key from the environment", async () => {
    process.env.ENV_ONLY_KEY = "from-env";
    try {
      const svc = defineService({
        ...echo,
        secrets: { ENV_ONLY_KEY: { label: "env key", description: "test" } },
      });
      const w = await setup([svc]).submit(envelope({ text: "x" }));
      expect(w.response.error.code).toBe("not_configured");
    } finally {
      delete process.env.ENV_ONLY_KEY;
    }
  });

  describe("settings", () => {
    const picky = defineService({
      ...echo,
      settings: {
        provider: {
          label: "Provider",
          description: "test",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
          required: true,
        },
        tone: {
          label: "Tone",
          description: "test",
          options: [{ value: "calm", label: "Calm" }],
          default: "calm",
        },
      },
      secrets: {
        B_KEY: {
          label: "B key",
          description: "test",
          neededWhen: (s) => s.provider === "b",
        },
      },
      handle: async (_i, ctx) => ok({ settings: ctx.settings, secrets: ctx.secrets }),
    });

    it("isn't set up until a required setting is picked", async () => {
      const w = await setup([picky]).submit(envelope({ text: "x" }));
      expect(w.response.error).toEqual({
        code: "not_configured",
        message:
          "echo isn't set up yet: it needs a choice of provider; an admin can set it up in Admin → Services",
      });
    });

    it("hands the handler its settings, defaults applied", async () => {
      const w = await setup([picky], { settings: { echo: { provider: "a" } } }).submit(
        envelope({ text: "x" }),
      );
      expect(w.response.result).toEqual({ settings: { provider: "a", tone: "calm" }, secrets: {} });
    });

    it("needs a key only when the settings call for it, and passes it either way", async () => {
      const needs = await setup([picky], { settings: { echo: { provider: "b" } } }).submit(
        envelope({ text: "x" }),
      );
      expect(needs.response.error.message).toMatch(/needs its B key/);
      const spare = await setup([picky], {
        settings: { echo: { provider: "a" } },
        keys: { "echo/B_KEY": "bk" },
      }).submit(envelope({ text: "x" }));
      expect(spare.response.result.secrets).toEqual({ B_KEY: "bk" });
    });
  });

  it("a key these settings don't use can't fail the request", async () => {
    const svc = defineService({
      ...echo,
      secrets: { SPARE: { label: "spare", description: "test", neededWhen: () => false } },
    });
    const engine = createAgentServiceEngine({
      services: [svc],
      ...storeDeps({}),
      getKey: async () => {
        throw new Error("bad blob");
      },
      now: () => NOW,
    });
    const answer = await engine.submit(HOST, request(envelope({ text: "x" })));
    expect(answer.body.ok).toBe(true);
  });

  it("a needed key the store can't read fails without passing the store's reason to the agent", async () => {
    const svc = defineService({ ...echo, secrets: { NEEDED: { label: "needed", description: "test" } } });
    const engine = createAgentServiceEngine({
      services: [svc],
      ...storeDeps({}),
      getKey: async () => {
        throw new Error("AWS refused to read keys under /takoyaki/t1000: arn:aws:sts::1:assumed-role/r");
      },
      now: () => NOW,
    });
    const answer = await engine.submit(HOST, request(envelope({ text: "x" })));
    expect((answer.body as Record<string, any>).error).toEqual({
      code: "internal",
      message: "echo can't read its keys right now; an admin can see why in Admin → Services",
    });
  });

  describe("machine switches", () => {
    it("refuses a machine the service isn't switched on for, before queueing", async () => {
      const handle = vi.fn(async () => ok({}));
      const w = await setup([{ ...echo, handle }], { grants: ["echo@other"] }).submit(
        envelope({ text: "x" }),
      );
      expect(handle).not.toHaveBeenCalled();
      expect(w.response.error).toEqual({
        code: "not_enabled",
        message:
          "echo isn't switched on for this machine; an admin can switch it on in Admin → Services",
      });
    });

    it("refuses a queued job whose machine was switched off while it waited", async () => {
      let on = true;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const handle = vi.fn(async (input: { text: string }) => {
        if (input.text === "first") await gate;
        return ok({});
      });
      const svc = defineService({ ...echo, handle });
      const engine = createAgentServiceEngine({
        services: [svc],
        ...storeDeps({}),
        isEnabled: async () => on,
        now: () => NOW,
      });
      const first = engine.submit(HOST, request(envelope({ text: "first" })));
      const second = engine.submit(
        HOST,
        request(envelope({ text: "second" }), {}, "bbbbbbbb-1111-4111-8111-111111111111"),
      );
      // Let both pass the switch check on arrival before switching off.
      await new Promise((r) => setTimeout(r, 0));
      on = false;
      release();
      await first;
      expect(((await second).body as Record<string, any>).error.code).toBe("not_enabled");
      expect(handle).toHaveBeenCalledTimes(1);
    });

    it("serves a machine it's switched on for", async () => {
      const w = await setup([echo], { grants: ["echo@m7"] }).submit(envelope({ text: "x" }));
      expect(w.response.ok).toBe(true);
    });

    it("answers a core handler for every machine, unrecorded", async () => {
      const recordUsage = vi.fn(async () => {});
      const core = defineService({ ...echo, name: "core-thing", title: "Core" });
      const w = await setup([echo], { grants: [], coreHandlers: [core], recordUsage }).submit({
        ...envelope({ text: "x" }),
        service: "core-thing",
      });
      expect(w.response.ok).toBe(true);
      expect(recordUsage).not.toHaveBeenCalled();
    });
  });

  describe("usage records", () => {
    const flaky = (code: string) =>
      defineService({
        ...echo,
        faultCodes: ["provider_down"],
        handle: async () => fail(code, "no"),
      });

    it("records each answer with its machine, and whether the service was at fault", async () => {
      const recordUsage = vi.fn(async () => {});
      await setup([echo], { recordUsage }).submit(envelope({ text: "x" }));
      await setup([flaky("provider_down")], { recordUsage }).submit(envelope({ text: "x" }));
      await setup([flaky("bad_prompt")], { recordUsage }).submit(envelope({ text: "x" }));
      await setup([echo], { recordUsage }).submit(envelope({ text: "" }));
      expect(recordUsage.mock.calls.map((c) => c[0])).toEqual([
        { service: "echo", machineId: "m7", hostId: 7, ok: true, code: null, fault: false },
        { service: "echo", machineId: "m7", hostId: 7, ok: false, code: "provider_down", fault: true },
        { service: "echo", machineId: "m7", hostId: 7, ok: false, code: "bad_prompt", fault: false },
        { service: "echo", machineId: "m7", hostId: 7, ok: false, code: "malformed", fault: false },
      ]);
    });

    it("counts a handler that throws as the service's fault", async () => {
      const recordUsage = vi.fn(async () => {});
      const svc = defineService({
        ...echo,
        handle: async () => {
          throw new Error("kaboom");
        },
      });
      await setup([svc], { recordUsage }).submit(envelope({ text: "x" }));
      expect(recordUsage.mock.calls[0][0]).toMatchObject({ code: "internal", fault: true });
    });
  });

  it("answers internal when the handler throws", async () => {
    const svc = defineService({
      ...echo,
      handle: async () => {
        throw new Error("kaboom");
      },
    });
    const w = await setup([svc]).submit(envelope({ text: "x" }));
    expect(w.response.error).toEqual({ code: "internal", message: "kaboom" });
  });

  describe("attachments", () => {
    const withRef = defineService({
      ...echo,
      attachments: { ref: { extensions: ["png"], maxBytes: 10 } },
      handle: async (_i, ctx) =>
        ok({ got: ctx.attachments.ref?.bytes.toString() ?? null, name: ctx.attachments.ref?.filename ?? null }),
    });
    const png = (text: string) => ({ ext: "png", bytes: Buffer.from(text) });

    it("hands declared attachments to the handler", async () => {
      const w = await setup([withRef]).submit(envelope({ text: "x" }), { ref: png("img") });
      expect(w.response.result).toEqual({ got: "img", name: "ref.png" });
    });

    it.each([
      ["an undeclared slot", { other: png("img") }, /unexpected attachment: other/],
      ["a type the slot doesn't take", { ref: { ext: "gif", bytes: Buffer.from("x") } }, /must be one of: png/],
      ["an empty file", { ref: png("") }, /missing or empty/],
      ["an oversized file", { ref: png("x".repeat(11)) }, /exceeds 10 bytes/],
    ])("rejects %s", async (_n, attachments, message) => {
      const w = await setup([withRef]).submit(envelope({ text: "x" }), attachments);
      expect(w.response.error.code).toBe("malformed");
      expect(w.response.error.message).toMatch(message);
    });

    it("rejects a request missing a required attachment", async () => {
      const svc = {
        ...withRef,
        attachments: {
          ref: { extensions: ["png"], maxBytes: 10, required: true },
        },
      };
      const w = await setup([svc]).submit(envelope({ text: "x" }));
      expect(w.response.error.message).toMatch(/ref is required/);
    });
  });

  it("answers queue_full past maxQueueDepth", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = defineService({
      ...echo,
      maxQueueDepth: 1,
      handle: async () => {
        await gate;
        return ok({});
      },
    });
    const { engine } = setup([svc]);
    const ids = ["a", "b", "c"].map(
      (c) => `${c.repeat(8)}-1111-4111-8111-111111111111`,
    );
    const answers = ids.map((id) => engine.submit(HOST, request(envelope({ text: "x" }), {}, id)));
    // one running, one pending, one rejected
    expect(((await answers[2]).body as Record<string, any>).error.code).toBe("queue_full");
    release();
    expect((await answers[0]).body.ok).toBe(true);
    expect((await answers[1]).body.ok).toBe(true);
  });

  it("refuses new attachments past the memory budget, and frees it as jobs finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = defineService({
      ...echo,
      concurrency: 5,
      attachments: { ref: { extensions: ["png"], maxBytes: 100 } },
      handle: async () => {
        await gate;
        return ok({});
      },
    });
    const engine = createAgentServiceEngine({
      services: [svc],
      ...storeDeps({}),
      now: () => NOW,
      maxHeldAttachmentBytes: 10,
    });
    const png = (n: number) => ({ ref: { ext: "png", bytes: Buffer.alloc(n, 1) } });
    const first = engine.submit(HOST, request(envelope({ text: "x" }), png(8), "aaaaaaaa-1111-4111-8111-111111111111"));
    const second = await engine.submit(HOST, request(envelope({ text: "x" }), png(8), "bbbbbbbb-1111-4111-8111-111111111111"));
    expect((second.body as Record<string, any>).error.code).toBe("queue_full");
    // Requests without attachments are never held back by it.
    const plain = engine.submit(HOST, request(envelope({ text: "x" }), {}, "cccccccc-1111-4111-8111-111111111111"));
    release();
    expect((await first).body.ok).toBe(true);
    expect((await plain).body.ok).toBe(true);
    const third = await engine.submit(HOST, request(envelope({ text: "x" }), png(8), "dddddddd-1111-4111-8111-111111111111"));
    expect(third.body.ok).toBe(true);
  });

  it("waits on the rate limiter before calling the handler", async () => {
    const acquire = vi.fn(async () => {});
    const createTokenBucket = vi.fn(() => ({
      acquire,
      getState: () => ({}) as any,
    }));
    const svc = defineService({ ...echo, rateLimitPerMinute: () => 12 });
    const engine = createAgentServiceEngine({
      services: [svc],
      ...storeDeps({}),
      now: () => NOW,
      createTokenBucket,
    });
    await engine.submit(HOST, request(envelope({ text: "x" })));
    expect(createTokenBucket).toHaveBeenCalledWith(12);
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("refuses duplicate service names", () => {
    expect(() => setup([echo, echo])).toThrow(/duplicate/);
  });

  describe("per-user secrets", () => {
    const zoho = defineService({
      ...echo,
      name: "zoho",
      userSecrets: {
        ZOHO_TOKEN: { label: "Zoho API token" },
        PREF: {
          label: "preference key",
          fallbackKey: "PREF_DEFAULT",
        },
      },
      secrets: {
        PREF_DEFAULT: {
          label: "default preference key",
          description: "test",
          neededWhen: () => false,
        },
      },
      handle: async (_i, ctx) =>
        ok({ user: ctx.user, secrets: ctx.userSecrets }),
    });
    const alice = { id: "u-alice", username: "alice" };
    const stored: Record<string, string> = {
      "u-alice/zoho/ZOHO_TOKEN": "tok",
      "u-alice/zoho/PREF": "pref",
    };
    const deps = (overrides: Parameters<typeof setup>[1] = {}) => ({
      resolveActingUser: vi.fn(async () => ({
        ok: true as const,
        user: alice,
      })),
      loadUserSecret: vi.fn(
        async (u: string, s: string, n: string) =>
          stored[`${u}/${s}/${n}`] ?? null,
      ),
      ...overrides,
    });

    it("resolves the acting user, passing as_user through, and hands the handler their secrets", async () => {
      const d = deps();
      const w = await setup([zoho], d).submit({
        ...envelope({ text: "x" }),
        service: "zoho",
        as_user: "alice",
      });
      expect(d.resolveActingUser).toHaveBeenCalledWith(7, "alice");
      expect(w.response.result).toEqual({
        user: alice,
        secrets: { ZOHO_TOKEN: "tok", PREF: "pref" },
      });
    });

    it("passes the resolver's refusal straight through", async () => {
      const d = deps({
        resolveActingUser: vi.fn(async () => ({
          ok: false as const,
          code: "ambiguous_user" as const,
          message: "several users; say which one with --as",
        })),
      });
      const w = await setup([zoho], d).submit({
        ...envelope({ text: "x" }),
        service: "zoho",
      });
      expect(w.response.error).toEqual({
        code: "ambiguous_user",
        message: "several users; say which one with --as",
      });
    });

    it("says an admin must set a missing per-person key", async () => {
      const d = deps({ loadUserSecret: vi.fn(async () => null) });
      const w = await setup([zoho], d).submit({
        ...envelope({ text: "x" }),
        service: "zoho",
      });
      expect(w.response.error.code).toBe("no_user_secret");
      expect(w.response.error.message).toBe(
        "alice has no Zoho API token for zoho; an admin can set it for them in Admin → Services",
      );
    });

    it("uses the service's fallback key for someone with none of their own", async () => {
      const missingPref = vi.fn(async (_u: string, _s: string, n: string) =>
        n === "ZOHO_TOKEN" ? "tok" : null,
      );
      const w = await setup(
        [zoho],
        deps({ loadUserSecret: missingPref }),
      ).submit({
        ...envelope({ text: "x" }),
        service: "zoho",
      });
      expect(w.response.error.message).toMatch(/Admin → Services/);

      const fallback = await setup([zoho], {
        ...deps({ loadUserSecret: missingPref }),
        keys: { "zoho/PREF_DEFAULT": "dflt" },
      }).submit({
        ...envelope({ text: "x" }),
        service: "zoho",
      });
      expect(fallback.response.result.secrets).toEqual({
        ZOHO_TOKEN: "tok",
        PREF: "dflt",
      });
    });

    it("answers internal when the secret store throws", async () => {
      const d = deps({
        loadUserSecret: vi.fn(async () =>
          Promise.reject(new Error("bad blob")),
        ),
      });
      const w = await setup([zoho], d).submit({
        ...envelope({ text: "x" }),
        service: "zoho",
      });
      expect(w.response.error).toEqual({
        code: "internal",
        message: "secret lookup failed: bad blob",
      });
    });

    it("leaves services without userSecrets alone", async () => {
      const d = deps();
      const w = await setup([echo], d).submit({
        ...envelope({ text: "x" }),
        as_user: "alice",
      });
      expect(d.resolveActingUser).not.toHaveBeenCalled();
      expect(w.response.ok).toBe(true);
    });

    it("refuses to start without a secret store, or with a bad secret name", () => {
      expect(() => setup([zoho])).toThrow(/no user secret store/);
      const bad = {
        ...zoho,
        userSecrets: {
          "zoho-token": { label: "x" },
        },
      };
      expect(() => setup([bad], deps())).toThrow(/UPPER_SNAKE/);
    });
  });
});
