import { describe, it, expect, afterEach } from "@jest/globals";
import {
  setSubscription,
  getSubscription,
  matchesSubscription,
  isSilentRoom,
} from "./notificationSubscriptions.js";

describe("notificationSubscriptions", () => {
  afterEach(() => setSubscription(null));

  describe("setSubscription / getSubscription", () => {
    it("starts with no subscription", () => {
      setSubscription(null);
      expect(getSubscription()).toBeNull();
    });

    it("stores and retrieves subscription", () => {
      setSubscription({ dms: true });
      expect(getSubscription()).toEqual({ dms: true });
    });
  });

  describe("matchesSubscription", () => {
    const event = { roomId: "!room:ex.com", sender: "@alice:ex.com", isDM: false };
    const dmEvent = { roomId: "!dm:ex.com", sender: "@bob:ex.com", isDM: true };

    it("returns false with no subscription", () => {
      setSubscription(null);
      expect(matchesSubscription(event)).toBe(false);
    });

    it("matches all events with all=true", () => {
      setSubscription({ all: true });
      expect(matchesSubscription(event)).toBe(true);
      expect(matchesSubscription(dmEvent)).toBe(true);
    });

    it("matches DMs with dms=true", () => {
      setSubscription({ dms: true });
      expect(matchesSubscription(dmEvent)).toBe(true);
      expect(matchesSubscription(event)).toBe(false);
    });

    it("matches specific room IDs", () => {
      setSubscription({ rooms: ["!room:ex.com"] });
      expect(matchesSubscription(event)).toBe(true);
      expect(matchesSubscription(dmEvent)).toBe(false);
    });

    it("matches specific user IDs", () => {
      setSubscription({ users: ["@alice:ex.com"] });
      expect(matchesSubscription(event)).toBe(true);
      expect(matchesSubscription(dmEvent)).toBe(false);
    });

    it("matches @mentions with mentionsOnly", () => {
      const oldEnv = process.env.MATRIX_USER_ID;
      process.env.MATRIX_USER_ID = "@mimir:ex.com";
      setSubscription({ mentionsOnly: true });

      expect(matchesSubscription({ ...event, body: "hey @mimir what do you think?" })).toBe(true);
      expect(matchesSubscription({ ...event, body: "no mention here" })).toBe(false);

      process.env.MATRIX_USER_ID = oldEnv;
    });

    it("mention matching uses word boundaries", () => {
      const oldEnv = process.env.MATRIX_USER_ID;
      process.env.MATRIX_USER_ID = "@opt:ex.com";
      setSubscription({ mentionsOnly: true });

      expect(matchesSubscription({ ...event, body: "the optimizer works well" })).toBe(false);
      expect(matchesSubscription({ ...event, body: "hey opt check this" })).toBe(true);

      process.env.MATRIX_USER_ID = oldEnv;
    });
  });

  describe("isSilentRoom", () => {
    it("returns false with no subscription", () => {
      setSubscription(null);
      expect(isSilentRoom("!room:ex.com")).toBe(false);
    });

    it("returns false for non-silent rooms", () => {
      setSubscription({ silentRooms: ["!other:ex.com"] });
      expect(isSilentRoom("!room:ex.com")).toBe(false);
    });

    it("returns true for silent rooms", () => {
      setSubscription({ silentRooms: ["!room:ex.com"] });
      expect(isSilentRoom("!room:ex.com")).toBe(true);
    });
  });
});
