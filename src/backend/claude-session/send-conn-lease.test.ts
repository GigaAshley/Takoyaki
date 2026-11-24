/**
 * send-conn-lease.test.ts
 *
 * A send already received must be typed even if the pane is torn down (app
 * closed) while it waits on a wake.
 *
 *   SL-1: no send in flight → teardown ends the connection at once
 *   SL-2: send in flight → end waits until it's released
 *   SL-3: several sends → end waits for the last one
 *   SL-4: a send that never finishes → cap ends the connection anyway
 *   SL-5: releasing twice counts once
 *   SL-6: lease released with no teardown asked → nothing ends; a later
 *         teardown ends at once
 *   SL-7: dormant send, pane torn down mid-wake → still sees the agent wake,
 *         types the message, and only then is the connection ended
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/logger.js", () => {
  const makeLogger = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  });
  const systemLogger = makeLogger();
  return {
    sshLogger: makeLogger(),
    authLogger: makeLogger(),
    databaseLogger: makeLogger(),
    apiLogger: makeLogger(),
    systemLogger,
    fileLogger: makeLogger(),
    statsLogger: makeLogger(),
    tunnelLogger: makeLogger(),
    dashboardLogger: makeLogger(),
    guacLogger: makeLogger(),
    versionLogger: makeLogger(),
    logger: systemLogger,
    setGlobalLogLevel: vi.fn(),
    getGlobalLogLevel: vi.fn(() => "info"),
  };
});

import {
  leaseSendConn,
  endConnWhenSendsDone,
  __resetSendConnLeasesForTests,
} from "./send-conn-lease.js";
import { __applyInputMessageForTests } from "./claude-session-server.js";

beforeEach(() => __resetSendConnLeasesForTests());
afterEach(() => vi.useRealTimers());

describe("send connection lease", () => {
  it("SL-1: nothing in flight → ends at once", () => {
    const conn = {};
    const end = vi.fn();
    expect(endConnWhenSendsDone(conn, end)).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SL-2: send in flight → ends once it's released", () => {
    const conn = {};
    const end = vi.fn();
    const release = leaseSendConn(conn);
    expect(endConnWhenSendsDone(conn, end)).toBe(true);
    expect(end).not.toHaveBeenCalled();
    release();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SL-3: several sends → waits for the last", () => {
    const conn = {};
    const end = vi.fn();
    const a = leaseSendConn(conn);
    const b = leaseSendConn(conn);
    endConnWhenSendsDone(conn, end);
    a();
    expect(end).not.toHaveBeenCalled();
    b();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SL-4: a send that never finishes → cap ends it", () => {
    vi.useFakeTimers();
    const conn = {};
    const end = vi.fn();
    const release = leaseSendConn(conn);
    endConnWhenSendsDone(conn, end, 1000);
    vi.advanceTimersByTime(999);
    expect(end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(end).toHaveBeenCalledTimes(1);
    release();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SL-5: double release counts once", () => {
    const conn = {};
    const end = vi.fn();
    const a = leaseSendConn(conn);
    const b = leaseSendConn(conn);
    endConnWhenSendsDone(conn, end);
    a();
    a();
    expect(end).not.toHaveBeenCalled();
    b();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SL-6: release with no teardown → nothing ends; later teardown is immediate", () => {
    const conn = {};
    const end = vi.fn();
    leaseSendConn(conn)();
    expect(end).not.toHaveBeenCalled();
    expect(endConnWhenSendsDone(conn, end)).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SL-7: dormant send survives teardown mid-wake", async () => {
    const conn = {} as import("ssh2").Client;
    let ended = false;
    const execCalls: string[] = [];
    const execCommand = vi.fn(async (_c: unknown, cmd: string) => {
      if (ended) throw new Error("Not connected");
      execCalls.push(cmd);
      return "";
    });
    const t0 = 1_000_000;
    let clock = t0;
    let markerPolls = 0;
    const end = vi.fn(() => {
      ended = true;
    });
    const release = leaseSendConn(conn);
    // The pane is torn down (app closed) on the first "awake yet?" check;
    // the agent reports awake on the third.
    const markerCommand = vi.fn(async () => {
      markerPolls++;
      if (markerPolls === 1) endConnWhenSendsDone(conn, end);
      clock += 500;
      return markerPolls >= 3 ? new Date(t0 + 1000).toISOString() : null;
    });
    const delivery = __applyInputMessageForTests({
      sshConn: conn,
      currentTmuxSession: "test-agent",
      currentHostId: 42,
      execCommand,
      data: "hello\r",
      messageQueueItemId: "pv-optim-1-abc",
      // The pane is already gone when the send runs: no view of its own, so
      // the host probe decides.
      dormantLastEmitted: () => null,
      setWakeTriggerTs: () => {},
      markerCommand,
      now: () => clock,
      paneProbe: async () => ({ isIdentity: true, dormantSentinel: true, claudeRunning: false }),
    }).finally(release);
    await delivery;
    expect(markerPolls).toBe(3);
    expect(execCalls).toContain("rm -f ~/fleet/identities/'test-agent'/.dormant");
    expect(execCalls).toContain("tmux send-keys -l -t 'test-agent' -- 'hello'");
    expect(execCalls).toContain("tmux send-keys -t 'test-agent' Enter");
    expect(end).toHaveBeenCalledTimes(1);
  }, 10_000);
});
