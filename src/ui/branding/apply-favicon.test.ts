import { describe, it, expect } from "vitest";
import { versionedFaviconHref } from "./apply-favicon";

describe("versionedFaviconHref", () => {
  it("adds the build id so a changed icon gets a new URL each deploy", () => {
    expect(versionedFaviconHref("/branding/favicon.svg", "abc123")).toBe("/branding/favicon.svg?v=abc123");
  });

  it("appends to an existing query string", () => {
    expect(versionedFaviconHref("/branding/favicon.svg?x=1", "abc123")).toBe("/branding/favicon.svg?x=1&v=abc123");
  });

  it("leaves the path alone when there is no build id", () => {
    expect(versionedFaviconHref("/branding/favicon.svg", "")).toBe("/branding/favicon.svg");
  });
});
