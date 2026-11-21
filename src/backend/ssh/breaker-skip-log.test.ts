import { describe, expect, it, vi } from "vitest";

import { createBreakerSkipLog } from "./breaker-skip-log.js";

const host = { id: "9", name: "desk-pc" };

function setup() {
  let t = 1_000_000;
  const logger = { info: vi.fn() };
  const skipLog = createBreakerSkipLog({
    subsystem: "spawn_scan",
    label: "Spawn-scan",
    logger,
    now: () => t,
  });
  return { logger, skipLog, advance: (ms: number) => (t += ms) };
}

describe("breaker-skip-log", () => {
  it("logs the first refusal only, however many ticks are refused", () => {
    const { logger, skipLog } = setup();
    for (let i = 0; i < 500; i++) skipLog.refused(host, "Circuit breaker OPEN");
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]![1]).toMatchObject({
      operation: "spawn_scan_host_skipping",
      fleetHostId: "9",
      hostName: "desk-pc",
      error: "Circuit breaker OPEN",
    });
  });

  it("logs a resume with how long the host was skipped, then starts over", () => {
    const { logger, skipLog, advance } = setup();
    skipLog.refused(host, "x");
    advance(90_000);
    skipLog.acquired(host);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls[1]![1]).toMatchObject({
      operation: "spawn_scan_host_resumed",
      skippedForSec: 90,
    });
    skipLog.refused(host, "x");
    expect(logger.info).toHaveBeenCalledTimes(3);
  });

  it("is silent for a host that was never skipped", () => {
    const { logger, skipLog } = setup();
    for (let i = 0; i < 10; i++) skipLog.acquired(host);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("tracks hosts independently", () => {
    const { logger, skipLog } = setup();
    skipLog.refused(host, "x");
    skipLog.refused({ id: "23", name: "other" }, "x");
    skipLog.acquired({ id: "23", name: "other" });
    skipLog.refused(host, "x");
    expect(logger.info.mock.calls.map((c) => (c[1] as { operation: string }).operation)).toEqual([
      "spawn_scan_host_skipping",
      "spawn_scan_host_skipping",
      "spawn_scan_host_resumed",
    ]);
  });
});
