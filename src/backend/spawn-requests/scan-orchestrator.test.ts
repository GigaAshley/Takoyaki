/**
 * scan-orchestrator.test.ts — the always-on visit that keeps the fleet name
 * census current (new agents and roles no longer come through here: see
 * direct-route.ts).
 *
 *   S, T — start() runs a first pass and installs the interval; every tick lists hosts.
 *   V    — a remote machine is connected to only when its census refresh is due, and
 *          the channel is released afterwards; a visit that hangs holds that host's
 *          guard until the visit timeout lets go.
 *   F, L — never throws; stop() ends it.
 *   N    — the census refresh itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SshChannel } from "../fleet-status/ssh-poll-orchestrator.js";
import type {
  SpawnScanHostRecord,
  SpawnScanCensusDeps,
} from "./scan-orchestrator.js";
import {
  FleetNameCensus,
  CENSUS_REMOTE_CMD,
} from "../pool/fleet-name-census.js";

vi.mock("../utils/logger.js", () => ({
  systemLogger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
  },
}));

// Partial-mock identity-artifact-reader so we control isLocalHostId per test.
// Default = false (matches "not local host" — existing SSH-branch tests keep
// working without change).
vi.mock("../claude-session/identity-artifact-reader.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../claude-session/identity-artifact-reader.js")>();
  return {
    ...actual,
    isLocalHostId: vi.fn().mockReturnValue(false),
  };
});

import { createSpawnScanOrchestrator } from "./scan-orchestrator.js";
import { isLocalHostId } from "../claude-session/identity-artifact-reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(): SshChannel {
  return { exec: vi.fn(async () => "") };
}

function makeDeps(overrides: {
  hosts?: SpawnScanHostRecord[];
  acquireChannel?: (host: SpawnScanHostRecord) => Promise<SshChannel | null>;
  scanIntervalMs?: number;
  scanTimeoutMs?: number;
  census?: SpawnScanCensusDeps;
} = {}) {
  const hosts =
    overrides.hosts ??
    ([{ id: "1", name: "host-1", _connDetails: {} }] as SpawnScanHostRecord[]);
  const channel = makeChannel();

  let capturedIntervalFn: (() => Promise<void> | void) | null = null;
  let intervalHandle = 0;

  const setIntervalMock = vi.fn((fn: () => Promise<void> | void, _ms: number) => {
    capturedIntervalFn = fn;
    intervalHandle++;
    return intervalHandle as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalMock = vi.fn();

  // Timeout mock: captures every scheduled callback so tests that want to
  // simulate a scan-timeout firing can invoke it manually via `fireTimeout()`.
  // Real time never advances — same pattern the setInterval mock uses.
  const capturedTimeoutFns: Array<{ fn: () => void; handle: number; cleared: boolean }> = [];
  let timeoutHandleCounter = 0;
  const setTimeoutMock = vi.fn((fn: () => void, _ms: number) => {
    timeoutHandleCounter++;
    const handle = timeoutHandleCounter;
    capturedTimeoutFns.push({ fn, handle, cleared: false });
    return handle as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimeoutMock = vi.fn((h: ReturnType<typeof setTimeout>) => {
    const entry = capturedTimeoutFns.find((e) => e.handle === (h as unknown as number));
    if (entry) entry.cleared = true;
  });

  const listSubstrateHosts = vi.fn(async () => hosts);
  const acquireChannel =
    overrides.acquireChannel ??
    vi.fn(async (_host: SpawnScanHostRecord) => channel);
  const releaseChannel = vi.fn();

  const deps = {
    listSubstrateHosts,
    acquireChannel,
    releaseChannel,
    setInterval: setIntervalMock,
    clearInterval: clearIntervalMock,
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    now: vi.fn(() => Date.now()),
    scanIntervalMs: overrides.scanIntervalMs,
    scanTimeoutMs: overrides.scanTimeoutMs,
    census: overrides.census,
  };

  return {
    deps,
    channel,
    listSubstrateHosts,
    acquireChannel: acquireChannel as ReturnType<typeof vi.fn>,
    releaseChannel,
    setIntervalMock,
    clearIntervalMock,
    setTimeoutMock,
    clearTimeoutMock,
    async fireTick() {
      if (capturedIntervalFn) await capturedIntervalFn();
    },
    /** Invoke the most-recently-scheduled un-cleared timeout callback. */
    fireLatestTimeout() {
      for (let i = capturedTimeoutFns.length - 1; i >= 0; i--) {
        if (!capturedTimeoutFns[i].cleared) {
          capturedTimeoutFns[i].fn();
          return true;
        }
      }
      return false;
    },
    capturedTimeoutFns,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Fire-and-forget per-host scans mean `start()` and `fireTick()` return
 * before the individual scanOneHost promises settle. Tests that assert on
 * mock-call counts (acquireChannel, scanSpawnRequests, enqueue) need to
 * drain the microtask queue first. Real setInterval doesn't await either,
 * so this mirrors production behavior.
 *
 * A handful of `Promise.resolve()` flushes covers scanOneHost's three
 * chained awaits (acquireChannel → scanSpawnRequests → releaseChannel).
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// S — start() semantics
// ---------------------------------------------------------------------------

describe("start() semantics", () => {
  it("S1: start() calls listSubstrateHosts exactly once and installs the interval", async () => {
    const { deps, listSubstrateHosts, setIntervalMock } = makeDeps();
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    expect(listSubstrateHosts).toHaveBeenCalledTimes(1);
    expect(setIntervalMock).toHaveBeenCalledTimes(1);
    expect(setIntervalMock.mock.calls[0][1]).toBe(10000); // default 10s
  });

  it("S3: scanIntervalMs override propagates to setInterval", async () => {
    const { deps, setIntervalMock } = makeDeps({ scanIntervalMs: 5000 });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    expect(setIntervalMock.mock.calls[0][1]).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// T — tick cadence
// ---------------------------------------------------------------------------

describe("tick cadence", () => {
  it("T1: interval tick fires scanAllHosts — listSubstrateHosts called on every tick", async () => {
    const { deps, listSubstrateHosts, fireTick } = makeDeps();
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    expect(listSubstrateHosts).toHaveBeenCalledTimes(1);

    await fireTick();
    expect(listSubstrateHosts).toHaveBeenCalledTimes(2);

    await fireTick();
    expect(listSubstrateHosts).toHaveBeenCalledTimes(3);
  });

  it("T2: getScanTickCount increments on every scan (initial pass = 1, each tick += 1)", async () => {
    const { deps, fireTick } = makeDeps();
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    expect(orch.getScanTickCount()).toBe(1);

    await fireTick();
    expect(orch.getScanTickCount()).toBe(2);

    await fireTick();
    expect(orch.getScanTickCount()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// F — never-throw contract
// ---------------------------------------------------------------------------

describe("never-throw contract", () => {
  it("F1: acquireChannel returning null → no throw, releaseChannel not called for null channel", async () => {
    const { deps, releaseChannel } = makeDeps({
      acquireChannel: vi.fn(async () => null),
      census: { census: new FleetNameCensus(), readLocal: vi.fn() },
    });
    const orch = createSpawnScanOrchestrator(deps);
    await expect(orch.start()).resolves.toBeUndefined();
    await flush();
    expect(releaseChannel).not.toHaveBeenCalled();
  });

  it("F2: listSubstrateHosts throwing → start() still resolves, nothing visited", async () => {
    const { deps, acquireChannel } = makeDeps({ census: { census: new FleetNameCensus(), readLocal: vi.fn() } });
    deps.listSubstrateHosts.mockRejectedValueOnce(new Error("db down"));
    const orch = createSpawnScanOrchestrator(deps);
    await expect(orch.start()).resolves.toBeUndefined();
    await flush();
    expect(acquireChannel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// L — lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("L1: stop() clears the interval and future ticks after stop are no-ops", async () => {
    const { deps, clearIntervalMock, listSubstrateHosts, fireTick } = makeDeps();
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    expect(listSubstrateHosts).toHaveBeenCalledTimes(1);

    orch.stop();
    expect(clearIntervalMock).toHaveBeenCalledTimes(1);

    // Even if a lingering interval callback somehow fires post-stop, it must
    // not re-enter scanAllHosts. The `stopped` flag guards this.
    await fireTick();
    expect(listSubstrateHosts).toHaveBeenCalledTimes(1);
  });

});

// ---------------------------------------------------------------------------
// V — a machine is visited only for its census
// ---------------------------------------------------------------------------

describe("visits", () => {
  const census = () => ({ census: new FleetNameCensus(), readLocal: vi.fn() });

  it("V1: a remote machine due a refresh is visited once over a channel, which is released", async () => {
    const { deps, acquireChannel, releaseChannel, fireTick } = makeDeps({ census: census() });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await flush();
    expect(acquireChannel).toHaveBeenCalledTimes(1);
    expect(releaseChannel).toHaveBeenCalledTimes(1);
    // Refreshed: not due again on the next tick, so no connection at all.
    await fireTick();
    await flush();
    expect(acquireChannel).toHaveBeenCalledTimes(1);
    orch.stop();
  });

  it("V2: without a census nothing is ever connected to", async () => {
    const { deps, acquireChannel, fireTick } = makeDeps();
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await fireTick();
    await flush();
    expect(acquireChannel).not.toHaveBeenCalled();
    orch.stop();
  });

  it("V3: a visit that hangs holds that host until the visit timeout lets go", async () => {
    const hangingAcquire = vi.fn((_host: SpawnScanHostRecord) => new Promise<SshChannel>(() => {}));
    const { deps, acquireChannel, fireTick, fireLatestTimeout } = makeDeps({
      acquireChannel: hangingAcquire,
      census: census(),
    });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await flush();
    expect(acquireChannel).toHaveBeenCalledTimes(1);
    await fireTick();
    await flush();
    expect(acquireChannel).toHaveBeenCalledTimes(1);
    expect(fireLatestTimeout()).toBe(true);
    await flush();
    await fireTick();
    await flush();
    expect(acquireChannel).toHaveBeenCalledTimes(2);
    orch.stop();
  });
});

// ---------------------------------------------------------------------------
// N — fleet name census refresh rides the per-host visit
// ---------------------------------------------------------------------------

describe("fleet name census refresh", () => {
  const isLocalHostIdMock = isLocalHostId as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    isLocalHostIdMock.mockReturnValue(false);
  });

  function censusDeps(census = new FleetNameCensus()): SpawnScanCensusDeps {
    return {
      census,
      readLocal: vi.fn(async () => ({
        live: ["local-box-maintainer"],
        archived: [{ name: "old-x", mtimeMs: 5 }],
      })),
    };
  }

  it("N1: first tick refreshes each machine over the existing channel", async () => {
    const census = censusDeps();
    const channel: SshChannel = {
      exec: vi.fn(async (cmd: string) =>
        cmd === CENSUS_REMOTE_CMD
          ? "L\tada-box-maintainer\nA\tbyron-x\t100\nEND\n"
          : "",
      ),
    };
    const { deps } = makeDeps({
      hosts: [{ id: "1", name: "h1", machineId: "m1", _connDetails: {} }],
      acquireChannel: vi.fn(async () => channel),
      census,
    });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await flush();
    // Census budget (default 10s) is passed INTO the exec so a wedged census
    // read frees its semaphore slot.
    expect(channel.exec).toHaveBeenCalledWith(CENSUS_REMOTE_CMD, undefined, { timeoutMs: 10000 });
    const snap = census.census.snapshot(99);
    expect(snap.ready).toBe(true);
    expect(snap.liveElsewhere.has("ada")).toBe(true);
    expect(snap.lastArchivedMs.get("byron")).toBe(100_000);
    orch.stop();
  });

  it("N2: two host rows for the same machine refresh it once; next tick not due", async () => {
    const census = censusDeps();
    const channel: SshChannel = { exec: vi.fn(async () => "END\n") };
    const { deps, fireTick } = makeDeps({
      hosts: [
        { id: "1", name: "h1-userA", machineId: "m1", _connDetails: {} },
        { id: "2", name: "h1-userB", machineId: "m1", _connDetails: {} },
      ],
      acquireChannel: vi.fn(async () => channel),
      census,
    });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await flush();
    await fireTick();
    await flush();
    const censusCalls = vi
      .mocked(channel.exec)
      .mock.calls.filter((c) => c[0] === CENSUS_REMOTE_CMD);
    expect(censusCalls).toHaveLength(1);
    orch.stop();
  });

  it("N3: failed exec keeps the last known picture", async () => {
    const census = new FleetNameCensus();
    census.recordMachine("m1", ["ada-x"], []);
    const channel: SshChannel = { exec: vi.fn(async () => null) };
    const { deps } = makeDeps({
      hosts: [{ id: "1", name: "h1", machineId: "m1", _connDetails: {} }],
      acquireChannel: vi.fn(async () => channel),
      census: censusDeps(census),
    });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await flush();
    // Census budget (default 10s) is passed INTO the exec so a wedged census
    // read frees its semaphore slot.
    expect(channel.exec).toHaveBeenCalledWith(CENSUS_REMOTE_CMD, undefined, { timeoutMs: 10000 });
    expect(census.snapshot(99).liveElsewhere.has("ada")).toBe(true);
    orch.stop();
  });

  it("N4: the local host reads its picture from the bind mount, no SSH", async () => {
    isLocalHostIdMock.mockImplementation((n: number) => n === 6);
    const census = censusDeps();
    const { deps, acquireChannel } = makeDeps({
      hosts: [{ id: "6", name: "self", machineId: "m-self", _connDetails: {} }],
      census,
    });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await flush();
    expect(acquireChannel).not.toHaveBeenCalled();
    expect(census.readLocal).toHaveBeenCalledTimes(1);
    expect(census.census.snapshot(6).liveOnTarget.has("local")).toBe(true);
    orch.stop();
  });

  it("N5: no census deps → no census exec", async () => {
    const channel: SshChannel = { exec: vi.fn(async () => "") };
    const { deps } = makeDeps({ acquireChannel: vi.fn(async () => channel) });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await flush();
    expect(vi.mocked(channel.exec).mock.calls.some((c) => c[0] === CENSUS_REMOTE_CMD)).toBe(false);
    orch.stop();
  });
});

describe("fleet name census refresh — logins and timeouts", () => {
  const isLocalHostIdMock = isLocalHostId as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    isLocalHostIdMock.mockReturnValue(false);
  });

  it("N6: two SSH logins on the same box are refreshed as separate fleets", async () => {
    const census = new FleetNameCensus();
    const channel: SshChannel = { exec: vi.fn(async () => "END\n") };
    const { deps } = makeDeps({
      hosts: [
        { id: "1", name: "box-ubuntu", machineId: "m1", _connDetails: { username: "ubuntu" } },
        { id: "2", name: "box-root", machineId: "m1", _connDetails: { username: "root" } },
      ],
      acquireChannel: vi.fn(async () => channel),
      census: { census, readLocal: vi.fn() },
    });
    const orch = createSpawnScanOrchestrator(deps);
    await orch.start();
    await flush();
    expect(
      vi.mocked(channel.exec).mock.calls.filter((c) => c[0] === CENSUS_REMOTE_CMD),
    ).toHaveLength(2);
    orch.stop();
  });

  it("N7: a census read that hangs is cut off and counted as a failed read", async () => {
    const census = new FleetNameCensus();
    census.recordMachine("m1", ["ada-x"], []);
    const channel: SshChannel = {
      exec: vi.fn((cmd: string) =>
        cmd === CENSUS_REMOTE_CMD ? new Promise<string | null>(() => {}) : Promise.resolve(""),
      ),
    };
    const h = makeDeps({
      hosts: [{ id: "1", name: "h1", machineId: "m1", _connDetails: {} }],
      acquireChannel: vi.fn(async () => channel),
      census: { census, readLocal: vi.fn() },
    });
    const orch = createSpawnScanOrchestrator(h.deps);
    await orch.start();
    await flush();
    h.fireLatestTimeout(); // the census read's own timeout
    await flush();
    expect(census.snapshot(99).liveElsewhere.has("ada")).toBe(true);
    expect(census.claimRefresh("m1")).toBe(false); // retry not yet due
    orch.stop();
  });
});
