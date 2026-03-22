import { setSubscription, getSubscription, matchesSubscription, isSilentRoom } from "./notificationSubscriptions.js";

describe("notificationSubscriptions", () => {
  afterEach(() => {
    setSubscription(null);
  });

  describe("matchesSubscription", () => {
    it("returns false when no subscription set", () => {
      expect(matchesSubscription({ roomId: "!r1:ex.com", sender: "@a:ex.com", isDM: false })).toBe(false);
    });

    it("matches all when all=true", () => {
      setSubscription({ all: true });
      expect(matchesSubscription({ roomId: "!r1:ex.com", sender: "@a:ex.com", isDM: false })).toBe(true);
    });

    it("matches DMs when dms=true", () => {
      setSubscription({ dms: true });
      expect(matchesSubscription({ roomId: "!r1:ex.com", sender: "@a:ex.com", isDM: true })).toBe(true);
      expect(matchesSubscription({ roomId: "!r1:ex.com", sender: "@a:ex.com", isDM: false })).toBe(false);
    });

    it("matches specific rooms", () => {
      setSubscription({ rooms: ["!r1:ex.com"] });
      expect(matchesSubscription({ roomId: "!r1:ex.com", sender: "@a:ex.com", isDM: false })).toBe(true);
      expect(matchesSubscription({ roomId: "!r2:ex.com", sender: "@a:ex.com", isDM: false })).toBe(false);
    });

    it("matches specific users", () => {
      setSubscription({ users: ["@alice:ex.com"] });
      expect(matchesSubscription({ roomId: "!r1:ex.com", sender: "@alice:ex.com", isDM: false })).toBe(true);
      expect(matchesSubscription({ roomId: "!r1:ex.com", sender: "@bob:ex.com", isDM: false })).toBe(false);
    });
  });

  describe("isSilentRoom", () => {
    it("returns false when no subscription set", () => {
      expect(isSilentRoom("!r1:ex.com")).toBe(false);
    });

    it("returns false when subscription has no silentRooms", () => {
      setSubscription({ dms: true });
      expect(isSilentRoom("!r1:ex.com")).toBe(false);
    });

    it("returns false when silentRooms is empty array", () => {
      setSubscription({ dms: true, silentRooms: [] });
      expect(isSilentRoom("!r1:ex.com")).toBe(false);
    });

    it("returns true for rooms in the silent list", () => {
      setSubscription({ dms: true, silentRooms: ["!r1:ex.com", "!r2:ex.com"] });
      expect(isSilentRoom("!r1:ex.com")).toBe(true);
      expect(isSilentRoom("!r2:ex.com")).toBe(true);
    });

    it("returns false for rooms not in the silent list", () => {
      setSubscription({ dms: true, silentRooms: ["!r1:ex.com"] });
      expect(isSilentRoom("!r3:ex.com")).toBe(false);
    });

    it("works with all=true subscription", () => {
      setSubscription({ all: true, silentRooms: ["!quiet:ex.com"] });
      // The room matches the subscription (all=true) but is silent
      expect(matchesSubscription({ roomId: "!quiet:ex.com", sender: "@a:ex.com", isDM: false })).toBe(true);
      expect(isSilentRoom("!quiet:ex.com")).toBe(true);
      // A non-silent room still matches and is not silent
      expect(matchesSubscription({ roomId: "!loud:ex.com", sender: "@a:ex.com", isDM: false })).toBe(true);
      expect(isSilentRoom("!loud:ex.com")).toBe(false);
    });
  });

  describe("getSubscription", () => {
    it("returns null when no subscription set", () => {
      expect(getSubscription()).toBeNull();
    });

    it("returns current subscription", () => {
      setSubscription({ dms: true, silentRooms: ["!r1:ex.com"] });
      const sub = getSubscription();
      expect(sub?.dms).toBe(true);
      expect(sub?.silentRooms).toEqual(["!r1:ex.com"]);
    });
  });
});
