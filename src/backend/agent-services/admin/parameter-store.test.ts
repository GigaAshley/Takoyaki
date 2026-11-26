/**
 * The Parameter Store key store against a stand-in for AWS: where keys go,
 * the hour-long cache, keeping the last value through an outage, and how
 * the server settings pick the store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { databaseLogger: stub, systemLogger: stub, authLogger: stub, sshLogger: stub };
});
vi.mock("../../database/db/index.js", () => ({ getDb: () => null }));

import { systemLogger } from "../../utils/logger.js";
import { KeyStoreRefusedError, databaseKeyStore } from "./key-store.js";
import {
  CACHE_TTL_MS,
  RETRY_WHILE_DOWN_MS,
  ParameterStoreUnreachableError,
  createParameterStoreKeyStore,
  type ParameterStoreClient,
} from "./parameter-store.js";
import { chooseKeyStore, normalizePath } from "./choose-store.js";

function fakeAws() {
  const params = new Map<string, string>();
  const types = new Map<string, string>();
  const gate = { hold: null as Promise<void> | null };
  const calls = { get: [] as string[][], put: [] as Array<{ name: string; kmsKeyId: string }> };
  const state = { mode: "ok" as "ok" | "refuse" | "down" };
  const fail = () => {
    if (state.mode === "refuse") throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
    if (state.mode === "down") throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
  };
  const client: ParameterStoreClient = {
    async getParameters(names) {
      calls.get.push(names);
      fail();
      const snapshot = new Map(params);
      if (gate.hold) await gate.hold;
      return {
        found: names
          .filter((n) => snapshot.has(n))
          .map((n) => ({ name: n, value: snapshot.get(n)!, type: types.get(n) ?? "SecureString", lastModified: new Date(0) })),
        missing: names.filter((n) => !snapshot.has(n)),
      };
    },
    async putParameter(name, value, kmsKeyId) {
      fail();
      calls.put.push({ name, kmsKeyId });
      params.set(name, value);
    },
    async deleteParameter(name) {
      fail();
      return params.delete(name);
    },
  };
  return { client, params, types, calls, state, gate };
}

let clock = 0;
const now = () => clock;

function store(aws = fakeAws()) {
  return { aws, keys: createParameterStoreKeyStore({ path: "/takoyaki/t800", kmsKeyId: "alias/fleet-secrets", client: aws.client, now }) };
}

beforeEach(() => {
  clock = 1_000_000;
  vi.mocked(systemLogger.warn).mockClear();
  vi.mocked(systemLogger.info).mockClear();
});

describe("Parameter Store key store", () => {
  it("keeps one parameter per key under the path, always with the named encryption key", async () => {
    const { aws, keys } = store();
    await keys.set("agent-phone", "TWILIO_AUTH_TOKEN", "tok", "u-admin");
    expect(aws.calls.put).toEqual([{ name: "/takoyaki/t800/agent-phone/TWILIO_AUTH_TOKEN", kmsKeyId: "alias/fleet-secrets" }]);
    expect(await keys.get("agent-phone", "TWILIO_AUTH_TOKEN")).toBe("tok");
    // A panel change is in the cache at once: no AWS read needed.
    expect(aws.calls.get).toEqual([]);
    expect(await keys.remove("agent-phone", "TWILIO_AUTH_TOKEN")).toBe(true);
    expect(await keys.get("agent-phone", "TWILIO_AUTH_TOKEN")).toBeNull();
    expect(await keys.remove("agent-phone", "TWILIO_AUTH_TOKEN")).toBe(false);
  });

  it("reads by exact name, once, and notices a change made in AWS within the hour", async () => {
    const { aws, keys } = store();
    aws.params.set("/takoyaki/t800/stt/GROQ_API_KEY", "gq-1");
    const both = await Promise.all([keys.get("stt", "GROQ_API_KEY"), keys.get("stt", "GROQ_API_KEY")]);
    expect(both).toEqual(["gq-1", "gq-1"]);
    expect(aws.calls.get).toEqual([["/takoyaki/t800/stt/GROQ_API_KEY"]]);

    aws.params.set("/takoyaki/t800/stt/GROQ_API_KEY", "gq-2"); // rotated by hand in AWS
    clock += CACHE_TTL_MS - 1;
    expect(await keys.get("stt", "GROQ_API_KEY")).toBe("gq-1");
    clock += 2;
    expect(await keys.get("stt", "GROQ_API_KEY")).toBe("gq-2");
  });

  it("keeps serving the last value through an outage, however long, and says when AWS is back", async () => {
    const { aws, keys } = store();
    aws.params.set("/takoyaki/t800/image-gen/OPENAI_API_KEY", "sk");
    expect(await keys.get("image-gen", "OPENAI_API_KEY")).toBe("sk");
    aws.state.mode = "down";
    clock += 5 * CACHE_TTL_MS;
    expect(await keys.get("image-gen", "OPENAI_API_KEY")).toBe("sk");
    expect(keys.info().unreachableSince).toBe(new Date(clock).toISOString());
    expect(systemLogger.warn).toHaveBeenCalledOnce();

    // While down, AWS is asked again at most once a minute.
    const asked = aws.calls.get.length;
    clock += RETRY_WHILE_DOWN_MS - 1;
    expect(await keys.get("image-gen", "OPENAI_API_KEY")).toBe("sk");
    expect(aws.calls.get.length).toBe(asked);
    clock += 2;
    await keys.get("image-gen", "OPENAI_API_KEY");
    expect(aws.calls.get.length).toBe(asked + 1);
    expect(systemLogger.warn).toHaveBeenCalledOnce();

    aws.state.mode = "ok";
    clock += RETRY_WHILE_DOWN_MS;
    expect(await keys.get("image-gen", "OPENAI_API_KEY")).toBe("sk");
    expect(keys.info().unreachableSince).toBeNull();
    expect(systemLogger.info).toHaveBeenCalledWith(
      "agent-services: AWS Parameter Store reachable again",
      expect.objectContaining({ operation: "agent_services_parameter_store_back" }),
    );
  });

  it("a key never read can't be served while AWS is down, and says why", async () => {
    const { aws, keys } = store();
    aws.state.mode = "down";
    await expect(keys.get("agent-phone", "TWILIO_AUTH_TOKEN")).rejects.toBeInstanceOf(ParameterStoreUnreachableError);
    await expect(keys.get("agent-phone", "TWILIO_AUTH_TOKEN")).rejects.toThrow("couldn't reach AWS Parameter Store");
  });

  it("a refusal is a setup mistake: never answered from the cache, and it names what to grant", async () => {
    const { aws, keys } = store();
    aws.params.set("/takoyaki/t800/image-gen/OPENAI_API_KEY", "sk");
    await keys.get("image-gen", "OPENAI_API_KEY");
    aws.state.mode = "refuse";
    clock += CACHE_TTL_MS;
    const read = keys.get("image-gen", "OPENAI_API_KEY");
    await expect(read).rejects.toBeInstanceOf(KeyStoreRefusedError);
    await expect(keys.get("image-gen", "OPENAI_API_KEY")).rejects.toThrow("kms:Decrypt on alias/fleet-secrets");
    await expect(keys.set("image-gen", "OPENAI_API_KEY", "x", null)).rejects.toThrow(
      "ssm:PutParameter on /takoyaki/t800/* and kms:Encrypt and kms:GenerateDataKey on alias/fleet-secrets",
    );
    await expect(keys.remove("image-gen", "OPENAI_API_KEY")).rejects.toThrow("ssm:DeleteParameter on /takoyaki/t800/*");
  });

  it("a read that was already out never undoes a change made from the panel", async () => {
    const { aws, keys } = store();
    aws.params.set("/takoyaki/t800/agent-phone/TWILIO_AUTH_TOKEN", "old");
    let release!: () => void;
    aws.gate.hold = new Promise((r) => (release = r));
    const read = keys.get("agent-phone", "TWILIO_AUTH_TOKEN"); // sees "old"
    await Promise.resolve();
    aws.gate.hold = null;
    await keys.set("agent-phone", "TWILIO_AUTH_TOKEN", "new", "u-admin");
    release();
    await read;
    expect(await keys.get("agent-phone", "TWILIO_AUTH_TOKEN")).toBe("new");

    // Same for a removal racing a panel status read.
    aws.gate.hold = new Promise((r) => (release = r));
    const status = keys.status("agent-phone", ["TWILIO_AUTH_TOKEN"]); // sees "new"
    await Promise.resolve();
    aws.gate.hold = null;
    await keys.remove("agent-phone", "TWILIO_AUTH_TOKEN");
    release();
    await status;
    expect(await keys.get("agent-phone", "TWILIO_AUTH_TOKEN")).toBeNull();
  });

  it("while AWS is down, keys never read and the panel don't wait on it more than once a minute", async () => {
    const { aws, keys } = store();
    aws.state.mode = "down";
    await expect(keys.get("agent-phone", "TWILIO_AUTH_TOKEN")).rejects.toBeInstanceOf(ParameterStoreUnreachableError);
    const asked = aws.calls.get.length;
    await expect(keys.get("agent-phone", "TWILIO_ACCOUNT_SID")).rejects.toThrow("couldn't reach AWS Parameter Store");
    expect(await keys.status("agent-phone", ["TWILIO_AUTH_TOKEN"])).toEqual([
      { name: "TWILIO_AUTH_TOKEN", isSet: null, updatedAt: null },
    ]);
    expect(aws.calls.get.length).toBe(asked);
    clock += RETRY_WHILE_DOWN_MS;
    await keys.status("agent-phone", ["TWILIO_AUTH_TOKEN"]);
    expect(aws.calls.get.length).toBe(asked + 1);
  });

  it("a value too long for Parameter Store is refused as such, not as a permissions problem", async () => {
    const { aws, keys } = store();
    await expect(keys.set("svc", "BIG", "x".repeat(4097), null)).rejects.toThrow("at most 4096 bytes");
    expect(aws.calls.put).toEqual([]);
    await keys.set("svc", "FITS", "x".repeat(4096), null);
    expect(aws.calls.put.length).toBe(1);
  });

  it("AWS rejecting the request itself doesn't send the admin off to fix permissions", async () => {
    const aws = fakeAws();
    aws.client.putParameter = async () => {
      throw Object.assign(new Error("Parameter name: bad"), { name: "ValidationException" });
    };
    const { keys } = store(aws);
    const err = await keys.set("svc", "KEY", "v", null).catch((e: Error) => e);
    expect(err).toBeInstanceOf(KeyStoreRefusedError);
    expect((err as Error).message).toContain("AWS refused to save the key: Parameter name: bad.");
    expect((err as Error).message).not.toContain("needs");
  });

  it("an entry made by hand as plain text is never served", async () => {
    const { aws, keys } = store();
    aws.params.set("/takoyaki/t800/svc/KEY", "plain");
    aws.types.set("/takoyaki/t800/svc/KEY", "String");
    expect(await keys.get("svc", "KEY")).toBeNull();
    expect(systemLogger.warn).toHaveBeenCalledWith(
      "agent-services: ignoring Parameter Store keys that aren't SecureStrings",
      expect.objectContaining({ names: ["/takoyaki/t800/svc/KEY"] }),
    );
  });

  it("status asks AWS each time, in batches of ten, and says what it can't tell", async () => {
    const { aws, keys } = store();
    const names = Array.from({ length: 12 }, (_, i) => `KEY_${i}`);
    aws.params.set("/takoyaki/t800/svc/KEY_3", "v");
    const first = await keys.status("svc", names);
    expect(aws.calls.get.map((b) => b.length)).toEqual([10, 2]);
    expect(first.filter((k) => k.isSet).map((k) => k.name)).toEqual(["KEY_3"]);
    expect(first[3].updatedAt).toBe(new Date(0).toISOString());

    aws.params.set("/takoyaki/t800/svc/KEY_4", "added in AWS");
    expect((await keys.status("svc", names)).filter((k) => k.isSet).map((k) => k.name)).toEqual(["KEY_3", "KEY_4"]);

    aws.state.mode = "down";
    const during = await keys.status("svc", [...names, "NEVER_SEEN"]);
    expect(during.find((k) => k.name === "KEY_3")!.isSet).toBe(true);
    expect(during.find((k) => k.name === "NEVER_SEEN")!.isSet).toBeNull();
  });
});

describe("choosing the store from the server settings", () => {
  const makeClient = () => fakeAws().client;

  it("neither setting: the database, as before", () => {
    expect(chooseKeyStore({}, makeClient)).toBe(databaseKeyStore);
  });

  it("path and encryption key: Parameter Store under that path", () => {
    const s = chooseKeyStore(
      { AGENT_SERVICES_PARAMETER_STORE_PATH: "/takoyaki/t1000/", AGENT_SERVICES_PARAMETER_STORE_KMS_KEY: "alias/fleet-secrets" },
      makeClient,
    );
    expect(s.info()).toEqual({
      kind: "parameter_store",
      label: "AWS Parameter Store under /takoyaki/t1000",
      problem: null,
      unreachableSince: null,
    });
  });

  it("only one of the two: a named setup mistake, and nothing falls back to the database", async () => {
    const s = chooseKeyStore({ AGENT_SERVICES_PARAMETER_STORE_PATH: "/takoyaki/t1000" }, makeClient);
    expect(s).not.toBe(databaseKeyStore);
    expect(s.info().problem).toContain("AGENT_SERVICES_PARAMETER_STORE_KMS_KEY is missing");
    await expect(s.get("image-gen", "OPENAI_API_KEY")).rejects.toBeInstanceOf(KeyStoreRefusedError);
    await expect(s.set("image-gen", "OPENAI_API_KEY", "x", null)).rejects.toBeInstanceOf(KeyStoreRefusedError);
    expect(await s.status("image-gen", ["OPENAI_API_KEY"])).toEqual([{ name: "OPENAI_API_KEY", isSet: null, updatedAt: null }]);
    expect(systemLogger.error).toHaveBeenCalled();
  });

  it("a path Parameter Store won't take is a setup mistake too", () => {
    for (const bad of ["takoyaki/t1000", "/aws/keys", "/has space", "/"]) {
      expect(normalizePath(bad)).toBeNull();
      const s = chooseKeyStore(
        { AGENT_SERVICES_PARAMETER_STORE_PATH: bad, AGENT_SERVICES_PARAMETER_STORE_KMS_KEY: "alias/fleet-secrets" },
        makeClient,
      );
      expect(s.info().problem).toContain("isn't a Parameter Store path");
    }
  });

  it("refuses AWS's own encryption keys, which every managed machine can use", () => {
    for (const key of ["alias/aws/ssm", "arn:aws:kms:us-east-1:662442740806:alias/aws/ssm"]) {
      const s = chooseKeyStore(
        { AGENT_SERVICES_PARAMETER_STORE_PATH: "/takoyaki/t1000", AGENT_SERVICES_PARAMETER_STORE_KMS_KEY: key },
        makeClient,
      );
      expect(s.info().problem).toContain("names one of AWS's own keys");
    }
  });

  it("uses us-east-1 unless the operator names a region", () => {
    const regions: string[] = [];
    const env = { AGENT_SERVICES_PARAMETER_STORE_PATH: "/t", AGENT_SERVICES_PARAMETER_STORE_KMS_KEY: "alias/k" };
    chooseKeyStore(env, (r) => (regions.push(r), fakeAws().client));
    chooseKeyStore({ ...env, AGENT_SERVICES_AWS_REGION: "us-west-2" }, (r) => (regions.push(r), fakeAws().client));
    expect(regions).toEqual(["us-east-1", "us-west-2"]);
  });
});
