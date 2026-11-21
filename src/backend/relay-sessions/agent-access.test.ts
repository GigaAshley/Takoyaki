import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  databaseLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../notifications/resolve-agent-host-id.js", () => ({ resolveAgentHostId: vi.fn() }));
vi.mock("../notifications/resolve-remote-agent-host-id.js", () => ({ resolveRemoteAgentHostId: vi.fn() }));
vi.mock("../utils/permission-manager.js", () => ({ PermissionManager: { getInstance: vi.fn() } }));

import { userCanActAsAgent, type AgentAccessDeps } from "./agent-access.js";

function deps(over: Partial<AgentAccessDeps>): AgentAccessDeps {
  return {
    resolveLocalHostId: vi.fn().mockResolvedValue(null),
    resolveRemoteHostId: vi.fn().mockResolvedValue(null),
    canAccessHost: vi.fn().mockResolvedValue(false),
    ...over,
  };
}

describe("userCanActAsAgent", () => {
  it("yes for an agent on this box when the user has that host", async () => {
    const d = deps({ resolveLocalHostId: vi.fn().mockResolvedValue(3), canAccessHost: vi.fn().mockResolvedValue(true) });
    expect(await userCanActAsAgent("u", "@finch:hs", d)).toBe(true);
    expect(d.canAccessHost).toHaveBeenCalledWith("u", 3);
  });

  it("no for an agent on this box when the user lacks that host and no peer box of theirs has it", async () => {
    const d = deps({ resolveLocalHostId: vi.fn().mockResolvedValue(3) });
    expect(await userCanActAsAgent("u", "@finch:hs", d)).toBe(false);
  });

  it("yes for an agent on one of the user's peer boxes", async () => {
    const d = deps({ resolveRemoteHostId: vi.fn().mockResolvedValue(9) });
    expect(await userCanActAsAgent("u", "@finch:hs", d)).toBe(true);
  });

  it("no for an account that isn't an agent anywhere, and on errors", async () => {
    expect(await userCanActAsAgent("u", "@stranger:hs", deps({}))).toBe(false);
    const d = deps({ resolveLocalHostId: vi.fn().mockRejectedValue(new Error("x")) });
    expect(await userCanActAsAgent("u", "@finch:hs", d)).toBe(false);
  });
});
