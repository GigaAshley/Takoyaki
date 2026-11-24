import { describe, it, expect, beforeEach } from "vitest";
import { readMeCache, writeMeCache } from "./me-cache";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("skynet_auth", JSON.stringify({ loggedIn: true, username: "alice" }));
});

describe("me-cache", () => {
  it("round-trips the user's own sidebar details", () => {
    writeMeCache({ username: "alice", userId: "u1", avatarPath: "a.webp", isAdmin: true });
    expect(readMeCache()).toEqual({ username: "alice", userId: "u1", avatarPath: "a.webp", isAdmin: true });
  });

  it("never paints another user's details", () => {
    writeMeCache({ username: "alice", userId: "u1", avatarPath: null, isAdmin: true });
    localStorage.setItem("skynet_auth", JSON.stringify({ loggedIn: true, username: "bob" }));
    expect(readMeCache()).toBeNull();
  });

  it("ignores a malformed copy", () => {
    localStorage.setItem("skynet:me-cache:v1", JSON.stringify({ owner: "alice", payload: { isAdmin: "yes" } }));
    expect(readMeCache()).toBeNull();
  });
});
