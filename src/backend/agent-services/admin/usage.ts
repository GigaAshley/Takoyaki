/**
 * agent-services/admin/usage.ts — one record per answered request, for the
 * Services view's state, usage and recent errors.
 *
 * A record says which service, which machine, when, and how it ended (ok, or
 * the error code, and whether that code means the service itself is at
 * fault). Never what was asked or answered. Records older than
 * USAGE_RETENTION_MS are cleared.
 */

import { and, desc, eq, gte, lt, ne, or } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { agentServiceUsage } from "../../database/db/schema.js";
import { systemLogger } from "../../utils/logger.js";
import { persist } from "./persist.js";

export const USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export interface UsageRecord {
  service: string;
  machineId: string;
  hostId: number;
  ok: boolean;
  code: string | null;
  fault: boolean;
}

let lastPrune = 0;

/** Never throws: a lost usage record must not lose the agent its answer. */
export async function recordUsage(r: UsageRecord, now: number = Date.now()): Promise<void> {
  try {
    const db = getDb();
    await db.insert(agentServiceUsage).values({ ...r, at: new Date(now).toISOString() });
    // A clock that stepped back prunes too, rather than waiting it out.
    if (now - lastPrune > PRUNE_EVERY_MS || now < lastPrune) {
      lastPrune = now;
      await db
        .delete(agentServiceUsage)
        .where(lt(agentServiceUsage.at, new Date(now - USAGE_RETENTION_MS).toISOString()));
    }
    await persist("agent_service_usage", false);
  } catch (err) {
    systemLogger.warn("agent-services: usage record failed", {
      operation: "agent_services_usage_record_failed",
      service: r.service,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ServiceHealth {
  /** The last success or service fault decides: true when it was a fault. */
  failing: boolean;
  /** That last fault, when failing. */
  lastFault: { at: string; code: string | null } | null;
  lastUsedAt: string | null;
}

/** Test hook: forget when usage was last pruned. */
export function __resetUsagePrune(): void {
  lastPrune = 0;
}

/** Whether the service is failing, from its most recent telling record. */
export async function serviceHealth(service: string): Promise<ServiceHealth> {
  const db = getDb();
  // The latest record that says something about the service itself: a
  // success, or a failure that is its fault. A bad request says nothing.
  const decisive = (
    await db
      .select({ at: agentServiceUsage.at, ok: agentServiceUsage.ok, code: agentServiceUsage.code })
      .from(agentServiceUsage)
      .where(
        and(
          eq(agentServiceUsage.service, service),
          or(eq(agentServiceUsage.ok, true), eq(agentServiceUsage.fault, true)),
        ),
      )
      .orderBy(desc(agentServiceUsage.id))
      .limit(1)
  )[0];
  // Last used: the last request the service was asked to do, not one
  // refused because the machine isn't switched on.
  const last = (
    await db
      .select({ at: agentServiceUsage.at })
      .from(agentServiceUsage)
      .where(
        and(
          eq(agentServiceUsage.service, service),
          or(eq(agentServiceUsage.ok, true), ne(agentServiceUsage.code, "not_enabled")),
        ),
      )
      .orderBy(desc(agentServiceUsage.id))
      .limit(1)
  )[0];
  const failing = Boolean(decisive && !decisive.ok);
  return {
    failing,
    lastFault: failing && decisive ? { at: decisive.at, code: decisive.code } : null,
    lastUsedAt: last?.at ?? null,
  };
}

export interface MachineUsage {
  machineId: string;
  requests: number;
  failed: number;
  lastAt: string;
}

export interface UsageSummary {
  sinceAt: string;
  requests: number;
  failed: number;
  byMachine: MachineUsage[];
  recentErrors: Array<{ at: string; machineId: string; code: string | null; fault: boolean }>;
}

/** Usage over the retention window, and the most recent errors. */
export async function usageSummary(service: string, now: number = Date.now()): Promise<UsageSummary> {
  const sinceAt = new Date(now - USAGE_RETENTION_MS).toISOString();
  const rows = await getDb()
    .select()
    .from(agentServiceUsage)
    .where(and(eq(agentServiceUsage.service, service), gte(agentServiceUsage.at, sinceAt)))
    .orderBy(desc(agentServiceUsage.id));
  const byMachine = new Map<string, MachineUsage>();
  let failed = 0;
  for (const r of rows) {
    if (!r.ok) failed++;
    const m = byMachine.get(r.machineId) ?? { machineId: r.machineId, requests: 0, failed: 0, lastAt: r.at };
    m.requests++;
    if (!r.ok) m.failed++;
    byMachine.set(r.machineId, m);
  }
  return {
    sinceAt,
    requests: rows.length,
    failed,
    byMachine: [...byMachine.values()].sort((a, b) => b.requests - a.requests),
    recentErrors: rows
      .filter((r) => !r.ok)
      .slice(0, 10)
      .map((r) => ({ at: r.at, machineId: r.machineId, code: r.code, fault: r.fault })),
  };
}
