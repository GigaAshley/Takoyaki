/**
 * spawn-requests/direct-route.ts — new agents and new roles asked for over the
 * machine's direct route.
 *
 * A machine asks for a new agent (an agent's request, or a scheduled
 * conversation's fire) or a new role with `fleet-service call identity-birth` /
 * `fleet-service call role-create`, and gets the answer on the same call: the
 * newborn's name (or the role's slug), or why it couldn't be made. The request
 * goes through the same birth queue and workers the old request folder fed;
 * only where the answer goes differs (`PendingBirth.respond`).
 *
 * Not agent services: the app's own machinery, answered for every machine as
 * core handlers (never switched, listed or recorded), like identity-reactivate.
 * Wired in agent-services/boot.ts.
 *
 * The request's id is the caller's; sending the same id again joins the first
 * request while this server holds it. A new agent's folder records the id
 * (`.birth-request`), so the same request sent after its answer was lost (a
 * server restart: `lost`) answers with the agent it already made. A role isn't
 * recorded that way: before sending a role request again after `lost`, look in
 * ~/fleet/roles/ for it.
 *
 * Input: the same fields the request files took (worker.ts / parse-request-body.ts),
 * without `requested_at` (filled in here when absent) and, for a role, `kind`.
 */

import { z } from "zod";
import { defineService, fail, ok } from "../agent-services/engine/types.js";
import type { ServiceContext } from "../agent-services/engine/types.js";
import { isLocalHostId } from "../claude-session/identity-artifact-reader.js";
import { parseRequestBody, parseRoleRequestBody } from "./parse-request-body.js";
import type { PendingBirth } from "./types.js";

export interface DirectRouteDeps {
  /** The birth queue (queue.ts enqueue). */
  enqueue(item: PendingBirth): void;
  /** The machine's connection details for the server's unattended SSH, or null when they
   *  can't be had (its credentials can't be read). */
  connDetailsFor(hostId: string): Promise<Record<string, unknown> | null>;
}

/** Any JSON object; the request-file parsers do the checking, so both ways in agree. */
const anyObject = z.record(z.string(), z.unknown());

const TTL_MS = 10 * 60 * 1000;

type Answer = { kind: "success" | "failure"; body: string };

/** Enqueue `item` and wait for its one answer. */
function answerOf(deps: DirectRouteDeps, item: Omit<PendingBirth, "respond">): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    let answered = false;
    deps.enqueue({
      ...item,
      respond: (kind, body) => {
        if (answered) return;
        answered = true;
        resolve({ kind, body });
      },
    });
  });
}

function toResult(a: Answer) {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(a.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // an unreadable answer is a failure below
  }
  if (a.kind === "success" && typeof body.name === "string") return ok(body);
  const reason = typeof body.reason === "string" ? body.reason : "birth_failed";
  return fail(reason, typeof body.message === "string" ? body.message : undefined);
}

async function hostFields(deps: DirectRouteDeps, ctx: ServiceContext) {
  if (isLocalHostId(ctx.host.idNum)) return { hostId: ctx.host.id, hostIdNum: ctx.host.idNum } as const;
  const details = await deps.connDetailsFor(ctx.host.id);
  if (details === null) return null;
  return { hostId: ctx.host.id, hostIdNum: ctx.host.idNum, hostConnDetails: details } as const;
}

export function createDirectBirthServices(deps: DirectRouteDeps) {
  const identityBirth = defineService({
    name: "identity-birth",
    title: "New agent",
    description: "Make a new agent on the asking machine",
    input: anyObject,
    ttlMs: TTL_MS,
    concurrency: 8,

    async handle(input, ctx) {
      const raw = JSON.stringify({ requested_at: new Date(ctx.now()).toISOString(), ...input });
      const parsed = parseRequestBody(ctx.requestId, raw);
      if (parsed.ok === false) return fail("malformed", parsed.message);
      const host = await hostFields(deps, ctx);
      if (host === null) return fail("peer_host_unreachable", "the server can't reach this machine");
      ctx.log.info("identity-birth: new agent asked for over the direct route", {
        requestId: ctx.requestId,
        hostId: ctx.host.id,
        roles: parsed.body.roles.length,
      });
      const b = parsed.body;
      return toResult(
        await answerOf(deps, {
          ...host,
          uuid: ctx.requestId,
          roles: b.roles,
          prompt: b.prompt,
          task: b.task,
          requested_at: b.requested_at,
          ...(b.users !== undefined ? { users: b.users } : {}),
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.project !== undefined ? { project: b.project } : {}),
          ...(b.requested_by !== undefined ? { requested_by: b.requested_by } : {}),
          direct: true,
        }),
      );
    },
  });

  const roleCreate = defineService({
    name: "role-create",
    title: "New role",
    description: "Make a new role on the asking machine",
    input: anyObject,
    ttlMs: TTL_MS,
    concurrency: 4,

    async handle(input, ctx) {
      const raw = JSON.stringify({ requested_at: new Date(ctx.now()).toISOString(), ...input, kind: "role" });
      const parsed = parseRoleRequestBody(raw);
      if (parsed.ok === false) return fail("malformed", parsed.message);
      const host = await hostFields(deps, ctx);
      if (host === null) return fail("peer_host_unreachable", "the server can't reach this machine");
      ctx.log.info("role-create: new role asked for over the direct route", {
        requestId: ctx.requestId,
        hostId: ctx.host.id,
      });
      return toResult(
        await answerOf(deps, {
          ...host,
          uuid: ctx.requestId,
          roles: [],
          prompt: "",
          task: null,
          requested_at: parsed.body.requested_at,
          roleRequest: parsed.body,
          direct: true,
        }),
      );
    },
  });

  return [identityBirth, roleCreate] as const;
}
