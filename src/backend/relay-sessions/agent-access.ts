/**
 * agent-access.ts — may this user act through this agent?
 *
 * Host access is the only access boundary: a user may act through an agent
 * when the agent's identity lives on a machine the user has access to. Used
 * before the backend signs in as an agent on a user's behalf (the quiet
 * rename grant), so a user can never borrow someone else's agent — or an
 * account that isn't an agent at all.
 *
 * Resolution mirrors push routing: this box first (then the user's access
 * to that host row is checked), then the user's peer boxes (that resolver
 * only probes hosts the user can reach). Never throws; any failure is "no".
 */

import { resolveAgentHostId } from "../notifications/resolve-agent-host-id.js";
import { resolveRemoteAgentHostId } from "../notifications/resolve-remote-agent-host-id.js";
import { PermissionManager } from "../utils/permission-manager.js";
import { databaseLogger } from "../utils/logger.js";

export interface AgentAccessDeps {
  resolveLocalHostId: (mxid: string) => Promise<number | null>;
  resolveRemoteHostId: (mxid: string, userId: string) => Promise<number | null>;
  canAccessHost: (userId: string, hostId: number) => Promise<boolean>;
}

const defaultDeps: AgentAccessDeps = {
  resolveLocalHostId: resolveAgentHostId,
  resolveRemoteHostId: resolveRemoteAgentHostId,
  canAccessHost: async (userId, hostId) =>
    (await PermissionManager.getInstance().canAccessHost(userId, hostId, "execute")).hasAccess,
};

export async function userCanActAsAgent(
  userId: string,
  agentMxid: string,
  deps: AgentAccessDeps = defaultDeps,
): Promise<boolean> {
  try {
    const localHostId = await deps.resolveLocalHostId(agentMxid);
    if (localHostId !== null && (await deps.canAccessHost(userId, localHostId))) return true;
    return (await deps.resolveRemoteHostId(agentMxid, userId)) !== null;
  } catch (err) {
    databaseLogger.warn("agent access check failed — treated as no access", {
      operation: "agent_access_check_failed",
      userId,
      agentMxid,
      error: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}
