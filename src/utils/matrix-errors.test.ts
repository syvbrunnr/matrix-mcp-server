import { describe, it, expect } from "@jest/globals";
import { shouldEvictClientCache, getDiagnosticHint } from "./matrix-errors.js";

describe("shouldEvictClientCache", () => {
  it("evicts on M_UNKNOWN_TOKEN", () => {
    expect(shouldEvictClientCache(new Error("M_UNKNOWN_TOKEN: token expired"))).toBe(true);
  });

  it("evicts on M_FORBIDDEN", () => {
    expect(shouldEvictClientCache(new Error("M_FORBIDDEN"))).toBe(true);
  });

  it("evicts on missing access token", () => {
    expect(shouldEvictClientCache(new Error("No access token supplied"))).toBe(true);
  });

  it("evicts on sync timeout", () => {
    expect(shouldEvictClientCache(new Error("initial sync timed out"))).toBe(true);
  });

  it("does NOT evict on rate limit", () => {
    expect(shouldEvictClientCache(new Error("M_LIMIT_EXCEEDED"))).toBe(false);
  });

  it("does NOT evict on not found", () => {
    expect(shouldEvictClientCache(new Error("M_NOT_FOUND"))).toBe(false);
  });

  it("handles non-Error input", () => {
    expect(shouldEvictClientCache("M_UNKNOWN_TOKEN")).toBe(true);
    expect(shouldEvictClientCache("some other string")).toBe(false);
  });
});

describe("getDiagnosticHint", () => {
  it("suggests power level check for forbidden errors", () => {
    const hint = getDiagnosticHint(new Error("M_FORBIDDEN: you lack permission"));
    expect(hint).toContain("power level");
  });

  it("suggests list-joined-rooms for not found", () => {
    const hint = getDiagnosticHint(new Error("M_NOT_FOUND"));
    expect(hint).toContain("list-joined-rooms");
  });

  it("suggests server-health for auth errors", () => {
    const hint = getDiagnosticHint(new Error("M_UNKNOWN_TOKEN"));
    expect(hint).toContain("get-server-health");
  });

  it("suggests server-health for E2EE errors", () => {
    const hint = getDiagnosticHint(new Error("OLM_BAD_MESSAGE_MAC"));
    expect(hint).toContain("E2EE");
  });

  it("suggests server-health for connection errors", () => {
    const hint = getDiagnosticHint(new Error("ECONNREFUSED"));
    expect(hint).toContain("Connection issue");
  });

  it("returns generic hint for unknown errors", () => {
    const hint = getDiagnosticHint(new Error("Something unexpected"));
    expect(hint).toContain("get-server-health");
  });
});
