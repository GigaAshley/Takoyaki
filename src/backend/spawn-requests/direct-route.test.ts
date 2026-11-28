/**
 * New agents and roles over the machine's direct route: the request is checked the same way
 * the request files were, goes into the birth queue with the caller's id, and the queue's one
 * answer comes back as the call's result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger.js", () => ({
  systemLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../claude-session/identity-artifact-reader.js", () => ({
  isLocalHostId: vi.fn((n: number) => n === 1),
}));

import type { ServiceContext } from "../agent-services/engine/types.js";
import type { PendingBirth } from "./types.js";
import { createDirectBirthServices } from "./direct-route.js";

function ctx(hostIdNum: number, requestId = "11111111-2222-3333-4444-555555555555"): ServiceContext {
  return {
    requestId,
    host: { id: String(hostIdNum), idNum: hostIdNum },
    attachments: {},
    secrets: {},
    settings: {},
    userSecrets: {},
    log: { info: vi.fn(), warn: vi.fn() },
    now: () => Date.parse("2026-11-27T12:00:00Z"),
  };
}

let queued: PendingBirth[] = [];
const connDetailsFor = vi.fn(async (_id: string): Promise<Record<string, unknown> | null> => ({ ip: "10.0.0.2" }));
const deps = { enqueue: (item: PendingBirth) => void queued.push(item), connDetailsFor };
const [identityBirth, roleCreate] = createDirectBirthServices(deps);

beforeEach(() => {
  queued = [];
  connDetailsFor.mockClear();
});

/** Run a handler; answer its queued item with `kind`/`body` once it's queued. */
async function run(
  svc: typeof identityBirth,
  input: Record<string, unknown>,
  c: ServiceContext,
  kind: "success" | "failure",
  body: unknown,
) {
  const p = svc.handle(input, c);
  for (let i = 0; i < 20 && queued.length === 0; i++) await Promise.resolve();
  queued[0]?.respond?.(kind, JSON.stringify(body));
  return p;
}

describe("identity-birth", () => {
  it("queues the request under the caller's id and answers with the newborn", async () => {
    const r = await run(identityBirth, { roles: ["eng"], task: "Check", prompt: "do it", project: "garden" }, ctx(1), "success", {
      name: "willow",
      birthed_at: "x",
    });
    expect(r).toEqual({ ok: true, result: { name: "willow", birthed_at: "x" } });
    expect(queued[0]).toMatchObject({
      uuid: "11111111-2222-3333-4444-555555555555",
      hostId: "1",
      hostIdNum: 1,
      roles: ["eng"],
      prompt: "do it",
      task: "Check",
      project: "garden",
      requested_at: "2026-11-27T12:00:00.000Z",
      direct: true,
    });
    expect(queued[0].hostConnDetails).toBeUndefined();
    expect(connDetailsFor).not.toHaveBeenCalled();
  });

  it("a remote machine's connection details ride along for the unattended birth", async () => {
    await run(identityBirth, { roles: [], task: null, prompt: "p" }, ctx(7), "success", { name: "duet" });
    expect(connDetailsFor).toHaveBeenCalledWith("7");
    expect(queued[0].hostConnDetails).toEqual({ ip: "10.0.0.2" });
  });

  it("a failure comes back as the call's failure", async () => {
    const r = await run(identityBirth, { roles: ["nope"], task: null, prompt: "p" }, ctx(1), "failure", { reason: "role_unknown" });
    expect(r).toEqual({ ok: false, code: "role_unknown" });
  });

  it("a malformed request is refused before anything is queued", async () => {
    const r = await identityBirth.handle({ roles: "eng", prompt: "p" }, ctx(1));
    expect(r).toMatchObject({ ok: false, code: "malformed" });
    expect(queued).toHaveLength(0);
  });

  it("a machine the server can't reach is refused", async () => {
    connDetailsFor.mockResolvedValueOnce(null);
    const r = await identityBirth.handle({ roles: [], task: null, prompt: "p" }, ctx(7));
    expect(r).toMatchObject({ ok: false, code: "peer_host_unreachable" });
    expect(queued).toHaveLength(0);
  });

  it("answered once: a second answer is ignored", async () => {
    const p = identityBirth.handle({ roles: [], task: null, prompt: "p" }, ctx(1));
    for (let i = 0; i < 20 && queued.length === 0; i++) await Promise.resolve();
    queued[0].respond?.("success", JSON.stringify({ name: "a" }));
    queued[0].respond?.("failure", JSON.stringify({ reason: "birth_failed" }));
    expect(await p).toEqual({ ok: true, result: { name: "a" } });
  });
});

describe("role-create", () => {
  it("queues a role request and answers with the role's slug", async () => {
    const r = await run(roleCreate, { name: "Garden Keeper", description: "Keeps the garden." }, ctx(1), "success", {
      name: "garden-keeper",
      created_at: "x",
    });
    expect(r).toEqual({ ok: true, result: { name: "garden-keeper", created_at: "x" } });
    expect(queued[0].roleRequest).toMatchObject({ kind: "role", name: "Garden Keeper", description: "Keeps the garden." });
    expect(queued[0].direct).toBe(true);
  });

  it("a malformed role request is refused", async () => {
    expect(await roleCreate.handle({ description: "no name" }, ctx(1))).toMatchObject({ ok: false, code: "malformed" });
  });
});
