import { describe, it, expect } from "vitest";
import {
  attachmentError,
  attachmentExt,
  buildResponse,
  engineFailure,
  parseEnvelope,
} from "./protocol.js";

describe("parseEnvelope", () => {
  const base = { service: "agent-phone", input: { a: 1 } };

  it("accepts a minimal request", () => {
    expect(parseEnvelope(JSON.stringify(base))).toEqual({ ok: true, envelope: base });
  });

  it("accepts pretty-printed JSON", () => {
    expect(parseEnvelope(JSON.stringify(base, null, 2)).ok).toBe(true);
  });

  it("rejects an unknown key, naming it and the service", () => {
    const r = parseEnvelope(JSON.stringify({ ...base, extra: 1 }));
    expect(r).toEqual({ ok: false, message: "unrecognized request field: extra", service: "agent-phone" });
  });

  it("rejects the file drop's old fields", () => {
    const r = parseEnvelope(JSON.stringify({ ...base, requested_at: "2026-10-08T00:00:00Z" }));
    expect(r.ok).toBe(false);
  });

  it.each([
    ["invalid JSON", "{nope", /invalid JSON/],
    ["a non-object", "[1]", /JSON object/],
    ["a bad service", JSON.stringify({ ...base, service: "Bad Name" }), /kebab-case/],
    ["missing input", JSON.stringify({ service: "x" }), /input is required/],
    ["a non-string as_user", JSON.stringify({ ...base, as_user: 7 }), /as_user/],
    ["an empty as_user", JSON.stringify({ ...base, as_user: "" }), /as_user/],
  ])("rejects %s", (_n, body, message) => {
    const r = parseEnvelope(body);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.message).toMatch(message);
  });

  it("accepts as_user", () => {
    expect(parseEnvelope(JSON.stringify({ ...base, as_user: "alice" }))).toEqual({
      ok: true,
      envelope: { ...base, as_user: "alice" },
    });
  });
});

describe("attachments", () => {
  const spec = { extensions: ["png", "jpg"], maxBytes: 4 };

  it("takes the extension from the sent filename, lower-cased", () => {
    expect(attachmentExt("cat.PNG")).toBe("png");
    expect(attachmentExt("ref.tar.gz")).toBe("gz");
    expect(attachmentExt("noext")).toBeNull();
    expect(attachmentExt("x.../etc")).toBeNull();
  });

  it("accepts a file that fits its slot", () => {
    expect(attachmentError("ref", { ext: "png", bytes: Buffer.from("abcd") }, spec)).toBeNull();
  });

  it.each([
    ["a type the slot doesn't take", { ext: "gif", bytes: Buffer.from("a") }, /must be one of: png, jpg/],
    ["a bad extension", { ext: "../x", bytes: Buffer.from("a") }, /bad extension/],
    ["an empty file", { ext: "png", bytes: Buffer.alloc(0) }, /missing or empty/],
    ["an oversized file", { ext: "png", bytes: Buffer.from("abcde") }, /exceeds 4 bytes/],
  ])("rejects %s", (_n, file, message) => {
    expect(attachmentError("ref", file, spec)).toMatch(message);
  });
});

describe("buildResponse", () => {
  it("builds a success listing each output file's type and size", () => {
    expect(
      buildResponse("image-gen", { ok: true, result: { n: 2 } }, [
        { ext: "png", bytes: Buffer.from("ab") },
        { ext: "png", bytes: Buffer.from("abc") },
      ]),
    ).toEqual({
      ok: true,
      service: "image-gen",
      result: { n: 2 },
      files: [
        { ext: "png", size: 2 },
        { ext: "png", size: 3 },
      ],
    });
  });

  it("builds a failure with details merged under the code", () => {
    expect(
      buildResponse("agent-phone", { ok: false, code: "busy", message: "line busy", details: { seconds: 4 } }),
    ).toEqual({ ok: false, service: "agent-phone", error: { seconds: 4, code: "busy", message: "line busy" } });
  });

  it("omits a missing message", () => {
    expect(buildResponse(null, engineFailure("internal"))).toEqual({
      ok: false,
      service: null,
      error: { code: "internal" },
    });
  });
});
