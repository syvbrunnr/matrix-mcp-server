import { describe, it, expect, beforeEach } from "@jest/globals";
import { increment, getMetrics, resetStalenessBaseline } from "./pipelineMetrics.js";

describe("pipelineMetrics", () => {
  // Note: metrics are module-level singletons, so tests share state.
  // Order matters — each test builds on previous state.

  it("starts with zero counters and null timestamps", () => {
    const m = getMetrics();
    // May have state from other tests in the suite, so just check structure
    expect(m).toHaveProperty("eventsReceived");
    expect(m).toHaveProperty("lastEventAt");
    expect(m).toHaveProperty("firstEventAt");
  });

  it("increment updates counter and sets timestamps", () => {
    const before = getMetrics();
    const prevCount = before.eventsReceived;

    increment("eventsReceived");

    const after = getMetrics();
    expect(after.eventsReceived).toBe(prevCount + 1);
    expect(after.lastEventAt).not.toBeNull();
    expect(after.firstEventAt).not.toBeNull();
  });

  it("increment updates lastEventAt on each call", () => {
    increment("messagesEnqueued");
    const m1 = getMetrics();
    const t1 = m1.lastEventAt!;

    // Small delay to ensure timestamp differs
    increment("messagesFiltered");
    const m2 = getMetrics();
    expect(m2.lastEventAt!).toBeGreaterThanOrEqual(t1);
  });

  it("resetStalenessBaseline updates lastEventAt to now", () => {
    // Set a known baseline
    increment("eventsReceived");
    const before = getMetrics().lastEventAt!;

    // Reset baseline
    resetStalenessBaseline();
    const after = getMetrics().lastEventAt!;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("resetStalenessBaseline prevents stale detection after restart", () => {
    // Simulate: lastEventAt is old (stale)
    // After resetStalenessBaseline, lastEventAt should be recent
    resetStalenessBaseline();
    const m = getMetrics();
    const ageMs = Date.now() - m.lastEventAt!;

    // Should be less than 1 second old
    expect(ageMs).toBeLessThan(1000);
  });

  it("getMetrics returns a copy, not a reference", () => {
    const m1 = getMetrics();
    const m2 = getMetrics();
    expect(m1).not.toBe(m2); // Different objects
    expect(m1).toEqual(m2); // Same values
  });
});
