/**
 * Event handlers extracted from autoSync.ts for file size compliance.
 *
 * Pure functions for processing Matrix sync events: DM detection,
 * message extraction, and edit handling.
 */
import { MatrixEvent, MatrixEventEvent, EventType, MatrixClient } from "matrix-js-sdk";
import { getMessageQueue, QueuedMessage } from "./messageQueue.js";

/**
 * Build set of DM room IDs from m.direct account data + fallback heuristic.
 */
export function buildDmRoomSet(client: MatrixClient): Set<string> {
  const dmRoomIds = new Set<string>();

  const mDirectContent = (client.getAccountData(EventType.Direct) as any)?.getContent() ?? {};
  for (const rooms of Object.values(mDirectContent)) {
    if (Array.isArray(rooms)) {
      for (const rid of rooms) {
        if (typeof rid === "string" && rid.startsWith("!")) dmRoomIds.add(rid);
      }
    }
  }

  // Fallback: 2-member non-public rooms
  for (const room of client.getRooms()) {
    if (!dmRoomIds.has(room.roomId)) {
      const joinRule = room.currentState.getStateEvents("m.room.join_rules", "")?.getContent()?.join_rule;
      if (joinRule !== "public" && room.getJoinedMemberCount() === 2) {
        dmRoomIds.add(room.roomId);
      }
    }
  }

  return dmRoomIds;
}

/**
 * Extract a QueuedMessage from a Matrix event, or null if should be skipped.
 */
export function extractQueuedMessage(
  event: MatrixEvent,
  ownUserId: string | null,
  dmRoomIds: Set<string>,
  client: MatrixClient,
): QueuedMessage | null {
  const evtType = event.getType();
  if (evtType !== EventType.RoomMessage && evtType !== EventType.RoomMessageEncrypted) return null;
  if (event.getSender() === ownUserId) return null;

  const content = event.getClearContent?.() || event.getContent();
  const relatesTo = content?.["m.relates_to"];
  // m.replace events are handled separately (edit logic)
  if (relatesTo?.rel_type === "m.replace") return null;
  if (event.isRedacted()) return null;

  const eid = event.getId();
  if (!eid) return null;

  const evtRoomId = event.getRoomId() || "";
  const room = client.getRoom(evtRoomId);
  const isEncrypted = evtType === EventType.RoomMessageEncrypted;

  // The Matrix SDK may put error messages IN the body field (e.g.
  // "** Unable to decrypt: DecryptionError: Unknown error **") which
  // makes content?.body truthy even though decryption actually failed.
  const bodyStr = String(content?.body || "");
  const isDecryptionError = isEncrypted && (
    !bodyStr ||
    bodyStr.startsWith("** Unable to decrypt") ||
    content?.msgtype === "m.bad.encrypted"
  );

  return {
    eventId: eid,
    roomId: evtRoomId,
    roomName: room?.name || evtRoomId,
    sender: event.getSender() || "",
    body: isDecryptionError ? "[encrypted]" : bodyStr,
    timestamp: event.getTs(),
    isDM: dmRoomIds.has(evtRoomId),
    ...(relatesTo?.rel_type === "io.element.thread" || relatesTo?.rel_type === "m.thread"
      ? { threadRootEventId: relatesTo.event_id } : {}),
    ...(relatesTo?.["m.in_reply_to"]?.event_id
      ? { replyToEventId: relatesTo["m.in_reply_to"].event_id } : {}),
    ...(isDecryptionError ? { decryptionFailed: true } : {}),
    ...(isDecryptionError ? { decryptionFailureReason: bodyStr || "unknown" } : {}),
  };
}

/**
 * Handle an m.replace (edit) event. Tries to update the original message
 * in-place if it's still in the queue. If already consumed, enqueues a new
 * message with editedOriginalEventId set.
 */
export function handleEditEvent(
  event: MatrixEvent,
  ownUserId: string | null,
  dmRoomIds: Set<string>,
  client: MatrixClient,
  queue: ReturnType<typeof getMessageQueue>,
): void {
  if (event.getSender() === ownUserId) return;

  const content = event.getClearContent?.() || event.getContent();
  const relatesTo = content?.["m.relates_to"];
  if (relatesTo?.rel_type !== "m.replace") return;

  const originalEventId = relatesTo.event_id as string | undefined;
  if (!originalEventId) return;

  const newContent = content["m.new_content"];
  const newBody = String(newContent?.body || "");
  if (!newBody) return;

  const editResult = queue.tryEditInPlace(originalEventId, newBody);

  if (editResult === "fetched") {
    // Original already consumed — enqueue as a new edit message
    const eid = event.getId();
    if (!eid) return;
    const evtRoomId = event.getRoomId() || "";
    const room = client.getRoom(evtRoomId);

    queue.enqueueMessage({
      eventId: eid,
      roomId: evtRoomId,
      roomName: room?.name || evtRoomId,
      sender: event.getSender() || "",
      body: newBody,
      timestamp: event.getTs(),
      isDM: dmRoomIds.has(evtRoomId),
      editedOriginalEventId: originalEventId,
    });
  }
  // "in-place" — already updated, nothing more to do
  // "not-found" — original was never queued (e.g. own message), skip
}

/**
 * Set up decryption recovery for an encrypted message that failed initial decryption.
 * Registers both an event listener (for when keys arrive via sync) and timed retries
 * (for when keys arrive via key backup or to-device messages with a delay).
 */
export function scheduleDecryptionRetries(
  event: MatrixEvent,
  eventId: string,
  client: MatrixClient,
  queue: ReturnType<typeof getMessageQueue>,
): void {
  // Listen for SDK-triggered decryption (keys arrive via sync)
  event.once(MatrixEventEvent.Decrypted, () => {
    try {
      const decryptedContent = event.getClearContent?.() || event.getContent();
      if (decryptedContent?.body) {
        queue.updateDecryptedBody(eventId, String(decryptedContent.body));
      }
    } catch (decErr: any) {
      console.error(`[autoSync] Decryption update failed for ${eventId}: ${decErr.message}`);
    }
  });

  // Timed retries — room keys may arrive via key backup or to-device messages.
  // Extended to 120s because Dendrite key sharing can be slow (observed 15s+ failures).
  const retryDelays = [2000, 5000, 15000, 30000, 60000, 120000]; // 2s, 5s, 15s, 30s, 60s, 120s
  for (const delay of retryDelays) {
    setTimeout(async () => {
      try {
        const crypto = client.getCrypto?.();
        if (!crypto) return;
        const currentContent = event.getClearContent?.();
        if (currentContent?.body) return; // Already decrypted
        await (event as any).attemptDecryption(crypto);
        const retryContent = event.getClearContent?.() || event.getContent();
        const retryBody = String(retryContent?.body || "");
        if (retryBody && retryBody !== "[encrypted]" && !retryBody.startsWith("** Unable to decrypt")) {
          queue.updateDecryptedBody(eventId, retryBody);
          console.error(`[autoSync] Decryption retry succeeded for ${eventId} after ${delay}ms`);
        }
      } catch {
        // Silent — retries are best-effort
      }
    }, delay);
  }
}
