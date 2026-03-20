import { setPhase2Status, getPhase2Status, isPhase2Complete, incrementRetry } from "./e2eeStatus.js";

describe("e2eeStatus", () => {
  const userId = "@test:example.com";
  const homeserver = "https://matrix.example.com";

  it("returns undefined for unknown user", () => {
    expect(getPhase2Status("@unknown:ex.com", homeserver)).toBeUndefined();
  });

  it("tracks in_progress state", () => {
    setPhase2Status(userId, homeserver, "in_progress");
    const status = getPhase2Status(userId, homeserver);
    expect(status?.state).toBe("in_progress");
    expect(status?.startedAt).toBeDefined();
    expect(status?.error).toBeUndefined();
  });

  it("tracks complete state", () => {
    setPhase2Status(userId, homeserver, "complete");
    const status = getPhase2Status(userId, homeserver);
    expect(status?.state).toBe("complete");
    expect(status?.completedAt).toBeDefined();
    expect(isPhase2Complete(userId, homeserver)).toBe(true);
  });

  it("tracks failed state with error message", () => {
    setPhase2Status(userId, homeserver, "failed", "SSSS restore failed");
    const status = getPhase2Status(userId, homeserver);
    expect(status?.state).toBe("failed");
    expect(status?.error).toBe("SSSS restore failed");
    expect(isPhase2Complete(userId, homeserver)).toBe(false);
  });

  it("isPhase2Complete returns false for non-complete states", () => {
    setPhase2Status(userId, homeserver, "in_progress");
    expect(isPhase2Complete(userId, homeserver)).toBe(false);

    setPhase2Status(userId, homeserver, "pending");
    expect(isPhase2Complete(userId, homeserver)).toBe(false);
  });

  it("incrementRetry tracks retry count", () => {
    const user2 = "@retry:example.com";
    expect(incrementRetry(user2, homeserver)).toBe(1);
    expect(incrementRetry(user2, homeserver)).toBe(2);
    const status = getPhase2Status(user2, homeserver);
    expect(status?.retryCount).toBe(2);
  });

  it("preserves retryCount across state changes", () => {
    const user3 = "@preserve:example.com";
    setPhase2Status(user3, homeserver, "in_progress");
    incrementRetry(user3, homeserver);
    setPhase2Status(user3, homeserver, "failed", "timeout");
    const status = getPhase2Status(user3, homeserver);
    expect(status?.retryCount).toBe(1);
    expect(status?.state).toBe("failed");
  });

  it("isolates status per user", () => {
    const alice = "@alice:ex.com";
    const bob = "@bob:ex.com";
    setPhase2Status(alice, homeserver, "complete");
    setPhase2Status(bob, homeserver, "failed", "error");
    expect(isPhase2Complete(alice, homeserver)).toBe(true);
    expect(isPhase2Complete(bob, homeserver)).toBe(false);
  });
});
