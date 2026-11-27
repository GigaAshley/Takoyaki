/**
 * agent-services/user-secrets/acting-user.ts — which Skynet user a request
 * acts for.
 *
 * A request arrives from a machine, not a person. The people who can be
 * behind it are the machine's registrants: every user with a host row for
 * the same machine (same machine id, or same ip + port + login; host rows
 * are per-user, so a shared box has one row per person who added it). Rules:
 *
 *   - `as_user` given (fleet-service --as <username>): that user, if they
 *     registered this host. Agents on a shared host may act for any of its
 *     registrants, the same trust agent-phone uses for who it may call.
 *   - otherwise, if exactly one user registered the host: that user.
 *   - otherwise: `ambiguous_user`, naming the registrants so the agent can
 *     retry with --as.
 */

import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { hosts, users } from "../../database/db/schema.js";
import type { ActingUserResolution } from "../engine/engine.js";
import type { ActingUser } from "../engine/types.js";

/**
 * Host rows for the same machine as `origin`: the same machine id, or the
 * same ip + port + login. A machine's requests run as one of its rows
 * (http/production.ts), so every row of the machine counts.
 */
export function sameMachineAs(origin: {
  ip: string;
  port: number;
  username: string;
  machineId: number | null;
}): SQL {
  const sameLogin = and(
    eq(hosts.ip, origin.ip),
    eq(hosts.port, origin.port),
    eq(hosts.username, origin.username),
  )!;
  return origin.machineId === null ? sameLogin : or(sameLogin, eq(hosts.machineId, origin.machineId))!;
}

/** Every user who registered the machine behind host row `hostIdNum`. */
export async function listHostRegistrants(
  hostIdNum: number,
): Promise<ActingUser[]> {
  const db = getDb();
  const origin = (
    await db
      .select({ ip: hosts.ip, port: hosts.port, username: hosts.username, machineId: hosts.machineId })
      .from(hosts)
      .where(eq(hosts.id, hostIdNum))
      .limit(1)
  )[0];
  if (!origin) return [];

  const sameMachine = await db
    .select({ userId: hosts.userId })
    .from(hosts)
    .where(sameMachineAs(origin));
  const userIds = [...new Set(sameMachine.map((h) => h.userId))];
  if (userIds.length === 0) return [];

  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.id, userIds));
  return rows.sort((a, b) => a.username.localeCompare(b.username));
}

export async function resolveActingUser(
  hostIdNum: number,
  asUser: string | undefined,
): Promise<ActingUserResolution> {
  const registrants = await listHostRegistrants(hostIdNum);

  if (asUser !== undefined) {
    const match = registrants.find((u) => u.username === asUser);
    if (match) return { ok: true, user: match };
    const exists = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, asUser))
      .limit(1);
    return exists.length === 0
      ? {
          ok: false,
          code: "unknown_user",
          message: `no user named "${asUser}"`,
        }
      : {
          ok: false,
          code: "not_permitted",
          message: `user "${asUser}" has not registered this host`,
        };
  }

  if (registrants.length === 1) return { ok: true, user: registrants[0] };
  if (registrants.length === 0) {
    return {
      ok: false,
      code: "not_permitted",
      message: "no user has registered this host",
    };
  }
  return {
    ok: false,
    code: "ambiguous_user",
    message: `this host is registered by several users (${registrants
      .map((u) => u.username)
      .join(", ")}); say which one with --as <username>`,
  };
}
