/**
 * ssh-one-shot.test.ts — unit tests for the credential-error classifier
 * that gates whether a connect-side error trips the circuit breaker.
 *
 * The classifier is the load-bearing correctness invariant for HIGH-2 in
 * the 2026-09-29 code review: auth failures (bad password, wrong key,
 * key-passphrase mismatch) must NOT open the breaker, because retrying
 * with the same bad credentials against a healthy host would just
 * reproduce the failure three times and block every other legitimate
 * caller of that peer.
 *
 * Full end-to-end coverage of connectOneShot (mocking ssh2's Client) is
 * out of scope here; those integration paths are covered by fleet-status
 * and orchestrator-level tests. This file targets the classifier itself.
 */

import { describe, expect, it, vi } from "vitest";

import type { Client as SSHClient } from "ssh2";

import { CircuitBreakerOpenError } from "./host-circuit-breaker.js";
import {
  connectOneShot,
  connectOneShotWithRetry,
  isCredentialError,
  SshConfigError,
} from "./ssh-one-shot.js";

describe("ssh-one-shot — isCredentialError", () => {
  it("returns true for ssh2 client-authentication errors", () => {
    // ssh2 tags auth-failure errors with `level: "client-authentication"`
    // when the auth loop exhausts all methods (see ssh2/lib/client.js).
    const err = Object.assign(new Error("All configured authentication methods failed"), {
      level: "client-authentication",
    });
    expect(isCredentialError(err)).toBe(true);
  });

  it("returns false for connect-refused / timeout / network-side errors", () => {
    // These carry no `.level` or a different level; they represent host
    // unavailability and SHOULD trip the breaker.
    expect(isCredentialError(new Error("Connect timeout after 5000ms"))).toBe(false);
    expect(isCredentialError(new Error("ECONNREFUSED 100.0.0.1:22"))).toBe(false);
    expect(
      isCredentialError(Object.assign(new Error("Protocol error"), { level: "protocol" })),
    ).toBe(false);
  });

  it("returns false for non-Error inputs (defensive)", () => {
    expect(isCredentialError(null)).toBe(false);
    expect(isCredentialError(undefined)).toBe(false);
    expect(isCredentialError("string error")).toBe(false);
    expect(isCredentialError(42)).toBe(false);
    expect(isCredentialError({})).toBe(false);
  });

  it("returns false when the level property is not the exact expected string", () => {
    // Guard against silent classifier bypass if ssh2 ever changes the tag.
    // A future test failure here signals a needed update, not a regression.
    expect(
      isCredentialError(Object.assign(new Error("x"), { level: "auth" })),
    ).toBe(false);
    expect(
      isCredentialError(Object.assign(new Error("x"), { level: "client-auth" })),
    ).toBe(false);
    expect(
      isCredentialError(Object.assign(new Error("x"), { level: 123 })),
    ).toBe(false);
  });
});

describe("ssh-one-shot — connectOneShotWithRetry", () => {
  const host = { ip: "100.64.0.1", username: "u", authType: "password", password: "p" };
  const client = {} as SSHClient;
  const noSleep = vi.fn(async () => {});

  it("retries a timeout once with the longer timeout and returns the client", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connect timeout after 3000ms"))
      .mockResolvedValueOnce(client);
    await expect(
      connectOneShotWithRetry(host, [3000, 8000], 1000, connect, noSleep),
    ).resolves.toBe(client);
    expect(connect.mock.calls.map((c) => c[1])).toEqual([3000, 8000]);
    expect(noSleep).toHaveBeenCalledWith(1000);
  });

  it("throws the last error once every attempt fails", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"));
    await expect(
      connectOneShotWithRetry(host, [3000, 8000], 0, connect, noSleep),
    ).rejects.toThrow("second");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not retry a credential error", async () => {
    const authErr = Object.assign(new Error("auth"), { level: "client-authentication" });
    const connect = vi.fn().mockRejectedValue(authErr);
    await expect(
      connectOneShotWithRetry(host, [3000, 8000], 0, connect, noSleep),
    ).rejects.toBe(authErr);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the circuit breaker is open", async () => {
    const open = new CircuitBreakerOpenError("100.64.0.1:22", Date.now() + 30_000);
    const connect = vi.fn().mockRejectedValue(open);
    await expect(
      connectOneShotWithRetry(host, [3000, 8000], 0, connect, noSleep),
    ).rejects.toBe(open);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not retry a config error", async () => {
    const cfgErr = new SshConfigError("Unsupported authType: none");
    const connect = vi.fn().mockRejectedValue(cfgErr);
    await expect(
      connectOneShotWithRetry(host, [3000, 8000], 0, connect, noSleep),
    ).rejects.toBe(cfgErr);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("connectOneShot rejects an unsupported authType as SshConfigError", async () => {
    await expect(
      connectOneShot({ ip: "100.64.0.1", username: "u", authType: "none" }, 1000),
    ).rejects.toBeInstanceOf(SshConfigError);
  });
});
