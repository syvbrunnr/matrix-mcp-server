import { jest, describe, it, expect } from "@jest/globals";
import { ReceiptType } from "matrix-js-sdk";
import { sendReadReceipt } from "./read-receipt.js";

describe("sendReadReceipt", () => {
  it("sends receipt for the last event in the room", async () => {
    const lastEvent = { getId: () => "$last" };
    const mockClient = {
      sendReadReceipt: jest.fn<any>().mockResolvedValue(undefined),
    };
    const mockRoom = {
      roomId: "!test:example.com",
      getLiveTimeline: () => ({
        getEvents: () => [{ getId: () => "$first" }, lastEvent],
      }),
    };

    await sendReadReceipt(mockClient as any, mockRoom as any);

    expect(mockClient.sendReadReceipt).toHaveBeenCalledWith(lastEvent, ReceiptType.Read);
  });

  it("does nothing when room has no events", async () => {
    const mockClient = {
      sendReadReceipt: jest.fn<any>(),
    };
    const mockRoom = {
      roomId: "!empty:example.com",
      getLiveTimeline: () => ({ getEvents: () => [] }),
    };

    await sendReadReceipt(mockClient as any, mockRoom as any);

    expect(mockClient.sendReadReceipt).not.toHaveBeenCalled();
  });

  it("swallows errors without throwing", async () => {
    const mockClient = {
      sendReadReceipt: jest.fn<any>().mockRejectedValue(new Error("M_UNKNOWN")),
    };
    const mockRoom = {
      roomId: "!fail:example.com",
      getLiveTimeline: () => ({
        getEvents: () => [{ getId: () => "$evt" }],
      }),
    };

    // Should not throw
    await expect(sendReadReceipt(mockClient as any, mockRoom as any)).resolves.toBeUndefined();
  });
});
