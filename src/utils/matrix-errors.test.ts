import { shouldEvictClientCache } from "./matrix-errors.js";

describe("shouldEvictClientCache", () => {
  it("returns true for M_UNKNOWN_TOKEN errors", () => {
    expect(shouldEvictClientCache(new Error("M_UNKNOWN_TOKEN: access token not found"))).toBe(true);
  });

  it("returns true for M_FORBIDDEN errors", () => {
    expect(shouldEvictClientCache(new Error("M_FORBIDDEN: You are not allowed"))).toBe(true);
  });

  it("returns true for 'No access token' errors", () => {
    expect(shouldEvictClientCache(new Error("No access token provided"))).toBe(true);
  });

  it("returns true for sync timeout errors", () => {
    expect(shouldEvictClientCache(new Error("initial sync timed out after 30s"))).toBe(true);
  });

  it("returns false for rate limit errors", () => {
    expect(shouldEvictClientCache(new Error("M_LIMIT_EXCEEDED: Too many requests"))).toBe(false);
  });

  it("returns false for not found errors", () => {
    expect(shouldEvictClientCache(new Error("M_NOT_FOUND: room not found"))).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(shouldEvictClientCache(new Error("Network timeout"))).toBe(false);
  });

  it("handles non-Error objects", () => {
    expect(shouldEvictClientCache("M_UNKNOWN_TOKEN")).toBe(true);
    expect(shouldEvictClientCache("some random string")).toBe(false);
  });

  it("handles undefined and null", () => {
    expect(shouldEvictClientCache(undefined)).toBe(false);
    expect(shouldEvictClientCache(null)).toBe(false);
  });
});
