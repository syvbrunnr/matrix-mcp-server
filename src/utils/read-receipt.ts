import { MatrixClient, Room, ReceiptType } from "matrix-js-sdk";

/**
 * Send a read receipt for the latest event in a room.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function sendReadReceipt(client: MatrixClient, room: Room): Promise<void> {
  try {
    const events = room.getLiveTimeline().getEvents();
    if (events.length === 0) return;

    const lastEvent = events[events.length - 1];
    await client.sendReadReceipt(lastEvent, ReceiptType.Read);
  } catch (error: any) {
    // Non-fatal — some homeservers may not support receipts
    console.error(`[ReadReceipt] Failed for room ${room.roomId}: ${error.message}`);
  }
}
