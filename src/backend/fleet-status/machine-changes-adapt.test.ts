/**
 * The sweep's `changes` entries as the registry holds them: camelCase, gate-only fields
 * kept for the filter, nothing invented.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  sshLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  databaseLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  systemLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { adaptChangeEntry } from "./ssh-poll-orchestrator.js";

describe("adaptChangeEntry", () => {
  it("a waiting move", () => {
    expect(
      adaptChangeEntry({
        id: "r1",
        seq: 4,
        kind: "agent-project",
        state: "waiting",
        target: { type: "agent", name: "finch" },
        audience: ["ann"],
        at: 12,
        to: { project: "garden" },
        to_audience: null,
        by_user: "u1",
      }),
    ).toEqual({
      id: "r1",
      kind: "agent-project",
      state: "waiting",
      target: { type: "agent", name: "finch" },
      at: 12,
      mine: false,
      audience: ["ann"],
      to: { project: "garden" },
      toAudience: null,
      byUser: "u1",
    });
  });

  it("a refusal, an agent coming back, a pin and a new project", () => {
    const base = { seq: null, audience: null, at: null } as const;
    expect(
      adaptChangeEntry({ ...base, id: "a", kind: "agent-pin", state: "refused", target: { type: "agent", name: "f" },
        to: { pinned: true }, reason: "it's being archived", code: "being_archived", by_agent: "wren" }),
    ).toMatchObject({ to: { pinned: true }, reason: "it's being archived", code: "being_archived", byAgent: "wren" });
    expect(
      adaptChangeEntry({ ...base, id: "b", kind: "agent-unarchive", state: "returning", target: { type: "agent", name: "w" },
        card: { display_name: "Wren", project: null } }).card,
    ).toEqual({ displayName: "Wren", project: null });
    expect(
      adaptChangeEntry({ ...base, id: "c", kind: "project-create", state: "failed",
        target: { type: "project", name: null, display_name: "Ops" } }).target,
    ).toEqual({ type: "project", name: null, displayName: "Ops" });
  });
});
