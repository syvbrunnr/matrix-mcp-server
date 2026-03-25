import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Set up mocks before importing
jest.unstable_mockModule("../../matrix/notificationSubscriptions.js", () => ({
  setSubscription: jest.fn(),
  getSubscription: jest.fn(),
}));

jest.unstable_mockModule("../../matrix/messageQueue.js", () => ({
  getMessageQueue: jest.fn(),
}));

// Dynamic imports after mocks
const { setSubscription, getSubscription } = await import("../../matrix/notificationSubscriptions.js");
const { getMessageQueue } = await import("../../matrix/messageQueue.js");
const { subscribeNotificationsHandler, unsubscribeNotificationsHandler } = await import("./notification-subscribe.js");

const mockSetSubscription = setSubscription as jest.MockedFunction<typeof setSubscription>;
const mockGetSubscription = getSubscription as jest.MockedFunction<typeof getSubscription>;
const mockGetMessageQueue = getMessageQueue as jest.MockedFunction<typeof getMessageQueue>;

describe("subscribeNotificationsHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMessageQueue.mockReturnValue({ peek: () => ({ count: 0, types: { messages: 0, reactions: 0, invites: 0 }, items: [] }) } as any);
  });

  it("subscribes to all notifications", async () => {
    mockGetSubscription.mockReturnValue({ all: true } as any);

    const result = await subscribeNotificationsHandler({ all: true });
    expect(mockSetSubscription).toHaveBeenCalledWith({ all: true });
    expect(result.content[0].text).toContain("all events");
  });

  it("subscribes to DMs", async () => {
    mockGetSubscription.mockReturnValue({ dms: true } as any);

    const result = await subscribeNotificationsHandler({ dms: true });
    expect(result.content[0].text).toContain("all DMs");
  });

  it("subscribes to mentions", async () => {
    mockGetSubscription.mockReturnValue({ mentionsOnly: true } as any);

    const result = await subscribeNotificationsHandler({ mentionsOnly: true });
    expect(result.content[0].text).toContain("@mentions in all rooms");
  });

  it("subscribes to specific rooms", async () => {
    mockGetSubscription.mockReturnValue({ rooms: ["!r1:ex.com", "!r2:ex.com"] } as any);

    const result = await subscribeNotificationsHandler({ rooms: ["!r1:ex.com", "!r2:ex.com"] });
    expect(result.content[0].text).toContain("rooms: !r1:ex.com, !r2:ex.com");
  });

  it("subscribes to specific users", async () => {
    mockGetSubscription.mockReturnValue({ users: ["@alice:ex.com"] } as any);

    const result = await subscribeNotificationsHandler({ users: ["@alice:ex.com"] });
    expect(result.content[0].text).toContain("users: @alice:ex.com");
  });

  it("combines multiple subscription types", async () => {
    mockGetSubscription.mockReturnValue({ dms: true, mentionsOnly: true, rooms: ["!r1:ex.com"] } as any);

    const result = await subscribeNotificationsHandler({ dms: true, mentionsOnly: true, rooms: ["!r1:ex.com"] });
    expect(result.content[0].text).toContain("all DMs");
    expect(result.content[0].text).toContain("@mentions");
    expect(result.content[0].text).toContain("rooms: !r1:ex.com");
  });

  it("subscribes with silent rooms", async () => {
    mockGetSubscription.mockReturnValue({ dms: true, silentRooms: ["!r1:ex.com", "!r2:ex.com"] } as any);

    const result = await subscribeNotificationsHandler({ dms: true, silentRooms: ["!r1:ex.com", "!r2:ex.com"] });
    expect(mockSetSubscription).toHaveBeenCalledWith({ dms: true, silentRooms: ["!r1:ex.com", "!r2:ex.com"] });
    expect(result.content[0].text).toContain("all DMs");
    expect(result.content[0].text).toContain("silent rooms (queue only): !r1:ex.com, !r2:ex.com");
  });

  it("warns when no filters specified", async () => {
    mockGetSubscription.mockReturnValue({} as any);

    const result = await subscribeNotificationsHandler({});
    expect(result.content[0].text).toContain("no filters specified");
    expect(result.content[0].text).toContain("no notifications will fire");
  });

  it("mentions pending messages when queued messages exist", async () => {
    mockGetSubscription.mockReturnValue({ dms: true } as any);
    mockGetMessageQueue.mockReturnValue({ peek: () => ({ count: 3, types: { messages: 3, reactions: 0, invites: 0 }, rooms: [] }) } as any);

    const result = await subscribeNotificationsHandler({ dms: true });
    expect(result.content[0].text).toContain("3 message(s) already queued");
    expect(result.content[0].text).toContain("get-queued-messages");
  });

  it("does not mention pending messages when queue is empty", async () => {
    mockGetSubscription.mockReturnValue({ dms: true } as any);

    const result = await subscribeNotificationsHandler({ dms: true });
    expect(result.content[0].text).not.toContain("already queued");
  });
});

describe("unsubscribeNotificationsHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("clears subscription and returns confirmation", async () => {
    const result = await unsubscribeNotificationsHandler();
    expect(mockSetSubscription).toHaveBeenCalledWith(null);
    expect(result.content[0].text).toContain("Unsubscribed from all notifications");
  });
});
