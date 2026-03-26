/**
 * AutoSync: always-on Matrix sync loop that pushes events into the MessageQueue.
 *
 * Started once at MCP server init. Creates a persistent Matrix client with
 * event listeners for messages, reactions, and invites. All events are
 * persisted to SQLite via MessageQueue, surviving MCP restarts.
 *
 * Sync token is stored in the queue DB so the client resumes exactly where
 * it left off — no duplicate messages after restart.
 */
import { RoomEvent, MatrixEvent, MatrixEventEvent, EventType, ClientEvent, MatrixClient, ThreadEvent } from "matrix-js-sdk";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../utils/server-helpers.js";
import { getMessageQueue, QueuedMessage } from "./messageQueue.js";
import { getCachedClient } from "./clientCache.js";
import { readFileSync } from "fs";
import path from "path";
import { increment, getMetrics, resetStalenessBaseline } from "./pipelineMetrics.js";

const DATA_DIR = process.env.MATRIX_DATA_DIR ?? path.join(process.cwd(), ".data");
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_CHECK_INTERVAL_MS = 3 * 60 * 1000;
/** If no events arrive for this long while sync claims healthy, warn about staleness */
const STALE_WARN_THRESHOLD_MS = 10 * 60 * 1000;
/** If sync goes unhealthy and stays unhealthy for this many consecutive checks, attempt restart */
const MAX_UNHEALTHY_BEFORE_RESTART = 2;

let running = false;
let keepAliveHandle: ReturnType<typeof setInterval> | null = null;
let syncCheckHandle: ReturnType<typeof setInterval> | null = null;
let syncClient: MatrixClient | null = null;
let consecutiveUnhealthy = 0;
let totalReconnects = 0;
let lastReconnectAt: number | null = null;

/**
 * Build set of DM room IDs from m.direct account data + fallback heuristic.
 */
function buildDmRoomSet(client: MatrixClient): Set<string> {
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
function extractQueuedMessage(
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

  return {
    eventId: eid,
    roomId: evtRoomId,
    roomName: room?.name || evtRoomId,
    sender: event.getSender() || "",
    body: String(content?.body || (isEncrypted ? "[encrypted]" : "")),
    timestamp: event.getTs(),
    isDM: dmRoomIds.has(evtRoomId),
    ...(relatesTo?.rel_type === "io.element.thread" || relatesTo?.rel_type === "m.thread"
      ? { threadRootEventId: relatesTo.event_id } : {}),
    ...(relatesTo?.["m.in_reply_to"]?.event_id
      ? { replyToEventId: relatesTo["m.in_reply_to"].event_id } : {}),
    ...(isEncrypted && !content?.body ? { decryptionFailed: true } : {}),
    ...((isEncrypted && !content?.body && (event as any).decryptionFailureReason)
      ? { decryptionFailureReason: (event as any).decryptionFailureReason } : {}),
  };
}

/**
 * Handle an m.replace (edit) event. Tries to update the original message
 * in-place if it's still in the queue. If already consumed, enqueues a new
 * message with editedOriginalEventId set.
 */
function handleEditEvent(
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
 * Start the auto-sync loop. Creates a persistent Matrix client and registers
 * event listeners that push incoming events into the MessageQueue.
 *
 * Call once at MCP server startup. Idempotent — calling again is a no-op.
 */
export async function startAutoSync(): Promise<void> {
  if (running) return;
  running = true;

  const { matrixUserId, homeserverUrl } = getMatrixContext(undefined);
  const accessToken = getAccessToken(undefined, undefined);
  const queue = getMessageQueue();

  // Sync token: prefer queue DB, fall back to old sync-state.json for migration
  let syncToken = queue.getSyncToken() || undefined;
  if (!syncToken) {
    try {
      const saved = JSON.parse(readFileSync(path.join(DATA_DIR, "sync-state.json"), "utf-8"));
      if (saved.syncToken) syncToken = saved.syncToken;
    } catch { /* no old state */ }
  }

  console.error("[autoSync] Starting...");
  const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken, syncToken);
  syncClient = client;
  const ownUserId = client.getUserId();

  // Persist current sync token
  const currentToken = client.store.getSyncToken();
  if (currentToken) queue.setSyncToken(currentToken);

  let dmRoomIds = buildDmRoomSet(client);

  // --- Catch-up scan: process events in timeline from initial sync ---
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "join") continue;

    const events = room.getLiveTimeline().getEvents();
    for (const event of events) {
      const evtType = event.getType();

      // Reactions on own messages
      if (evtType === "m.reaction") {
        const relatesTo = event.getContent()?.["m.relates_to"];
        if (relatesTo?.rel_type === "m.annotation" && relatesTo.key && relatesTo.event_id) {
          const targetEvent = client.getRoom(event.getRoomId() || "")?.findEventById(relatesTo.event_id);
          if (targetEvent?.getSender() === ownUserId) {
            queue.enqueueReaction({
              eventId: event.getId() || "",
              roomId: event.getRoomId() || "",
              roomName: room.name || event.getRoomId() || "",
              sender: event.getSender() || "",
              emoji: relatesTo.key,
              reactedToEventId: relatesTo.event_id,
              timestamp: event.getTs(),
            });
          }
        }
        continue;
      }

      // Handle edits (m.replace)
      const catchupContent = event.getClearContent?.() || event.getContent();
      if (catchupContent?.["m.relates_to"]?.rel_type === "m.replace") {
        handleEditEvent(event, ownUserId, dmRoomIds, client, queue);
        continue;
      }

      const msg = extractQueuedMessage(event, ownUserId, dmRoomIds, client);
      if (msg) queue.enqueueMessage(msg);
    }
  }

  // Catch-up: pending invites
  for (const room of client.getRooms()) {
    if (room.getMyMembership() === "invite") {
      const member = room.currentState.getMember(ownUserId || "");
      const invitedBy = member?.events?.member?.getSender() ?? "unknown";
      queue.enqueueInvite({
        roomId: room.roomId,
        roomName: room.name || room.roomId,
        invitedBy,
        timestamp: Date.now(),
      });
    }
  }

  // --- Live event listeners ---
  client.on(RoomEvent.Timeline, (event: MatrixEvent) => {
    try {
      increment("eventsReceived");
      const evtType = event.getType();
      const evtRoomId = event.getRoomId() || "";

      // Reactions on own messages
      if (evtType === "m.reaction") {
        const relatesTo = event.getContent()?.["m.relates_to"];
        if (relatesTo?.rel_type === "m.annotation" && relatesTo.key && relatesTo.event_id) {
          const targetEvent = client.getRoom(evtRoomId)?.findEventById(relatesTo.event_id);
          if (targetEvent?.getSender() === ownUserId) {
            queue.enqueueReaction({
              eventId: event.getId() || "",
              roomId: evtRoomId,
              roomName: client.getRoom(evtRoomId)?.name || evtRoomId,
              sender: event.getSender() || "",
              emoji: relatesTo.key,
              reactedToEventId: relatesTo.event_id,
              timestamp: event.getTs(),
            });
            increment("reactionsEnqueued");
          }
        }
        return;
      }

      // Handle edits (m.replace)
      const liveContent = event.getClearContent?.() || event.getContent();
      if (liveContent?.["m.relates_to"]?.rel_type === "m.replace") {
        handleEditEvent(event, ownUserId, dmRoomIds, client, queue);
        increment("editsProcessed");
        return;
      }

      const msg = extractQueuedMessage(event, ownUserId, dmRoomIds, client);
      if (!msg) {
        increment("messagesFiltered");
        return;
      }

      const enqueued = queue.enqueueMessage(msg);
      if (enqueued) {
        increment("messagesEnqueued");
      } else {
        increment("messagesDeduplicated");
      }

      // For encrypted messages, listen for decryption to update body in the queue DB
      if (enqueued && msg.decryptionFailed) {
        event.once(MatrixEventEvent.Decrypted, () => {
          try {
            const decryptedContent = event.getClearContent?.() || event.getContent();
            if (decryptedContent?.body) {
              queue.updateDecryptedBody(msg.eventId, String(decryptedContent.body));
            }
          } catch (decErr: any) {
            console.error(`[autoSync] Decryption update failed for ${msg.eventId}: ${decErr.message}`);
          }
        });
      }
    } catch (err: any) {
      increment("listenerErrors");
      const eid = event.getId?.() || "unknown";
      const etype = event.getType?.() || "unknown";
      console.error(`[autoSync] Live listener error processing event ${eid} (${etype}): ${err.message}`);
    }
  });

  // Thread replies go to thread timelines, not the room's main timeline.
  // The client doesn't re-emit ThreadEvent.NewReply, so attach per-room listeners.
  const attachThreadListener = (room: any) => {
    room.on(ThreadEvent.NewReply, (_thread: any, event: MatrixEvent) => {
      try {
        increment("eventsReceived");
        const msg = extractQueuedMessage(event, ownUserId, dmRoomIds, client);
        if (!msg) return;
        const enqueued = queue.enqueueMessage(msg);
        if (enqueued) {
          increment("messagesEnqueued");
          if (msg.decryptionFailed) {
            event.once(MatrixEventEvent.Decrypted, () => {
              try {
                const decryptedContent = event.getClearContent?.() || event.getContent();
                if (decryptedContent?.body) {
                  queue.updateDecryptedBody(msg.eventId, String(decryptedContent.body));
                }
              } catch (decErr: any) {
                console.error(`[autoSync] Decryption update failed for ${msg.eventId}: ${decErr.message}`);
              }
            });
          }
        }
      } catch (err: any) {
        increment("listenerErrors");
        console.error(`[autoSync] Thread reply listener error: ${err.message}`);
      }
    });
  };
  // Attach to existing rooms
  for (const room of client.getRooms()) {
    attachThreadListener(room);
  }
  // Attach to newly joined rooms
  client.on(ClientEvent.Room, (room: any) => {
    attachThreadListener(room);
  });

  // Live invite detection
  const handleInviteRoom = (room: any) => {
    if (room.getMyMembership() !== "invite") return;
    const member = room.currentState?.getMember(ownUserId || "");
    const invitedBy = member?.events?.member?.getSender() ?? "unknown";
    queue.enqueueInvite({
      roomId: room.roomId,
      roomName: room.name || room.roomId,
      invitedBy,
      timestamp: Date.now(),
    });
  };

  client.on(ClientEvent.Room, handleInviteRoom);
  client.on(RoomEvent.MyMembership, (room: any, membership: string) => {
    if (membership === "invite") handleInviteRoom(room);
  });

  // --- Maintenance intervals ---
  keepAliveHandle = setInterval(() => {
    getCachedClient(matrixUserId, homeserverUrl);
    const token = client.store.getSyncToken();
    if (token) queue.setSyncToken(token);
    dmRoomIds = buildDmRoomSet(client);
    queue.cleanup();
  }, KEEPALIVE_INTERVAL_MS);

  syncCheckHandle = setInterval(async () => {
    const state = client.getSyncState();
    const isUnhealthy = state === "STOPPED" || state === null || state === "ERROR";

    if (isUnhealthy) {
      consecutiveUnhealthy++;
      console.error(`[autoSync] Sync unhealthy (${state}), consecutive=${consecutiveUnhealthy}`);

      if (consecutiveUnhealthy >= MAX_UNHEALTHY_BEFORE_RESTART) {
        console.error("[autoSync] Attempting sync restart...");
        try {
          client.stopClient();
          await client.startClient({ initialSyncLimit: 20, pollTimeout: 10_000 });
          totalReconnects++;
          lastReconnectAt = Date.now();
          consecutiveUnhealthy = 0;
          console.error("[autoSync] Sync restarted successfully");
        } catch (err: any) {
          console.error(`[autoSync] Sync restart failed: ${err.message}`);
        }
      }
    } else {
      consecutiveUnhealthy = 0;
    }

    // Staleness check: sync claims healthy but no events for a long time
    const metrics = getMetrics();
    if (!isUnhealthy && metrics.lastEventAt) {
      const silenceMs = Date.now() - metrics.lastEventAt;
      if (silenceMs > STALE_WARN_THRESHOLD_MS * 2) {
        // Double the threshold = force restart (not just warn)
        console.error(`[autoSync] Stale for ${Math.round(silenceMs / 1000)}s — forcing sync restart`);
        try {
          client.stopClient();
          await client.startClient({ initialSyncLimit: 20, pollTimeout: 10_000 });
          totalReconnects++;
          lastReconnectAt = Date.now();
          resetStalenessBaseline();
          console.error("[autoSync] Stale sync restarted successfully");
        } catch (err: any) {
          console.error(`[autoSync] Stale sync restart failed: ${err.message}`);
        }
      } else if (silenceMs > STALE_WARN_THRESHOLD_MS) {
        console.error(`[autoSync] Stale: sync is ${state} but no events for ${Math.round(silenceMs / 1000)}s`);
      }
    }
  }, SYNC_CHECK_INTERVAL_MS);

  console.error("[autoSync] Ready — listening for events");
}

export function stopAutoSync(): void {
  if (keepAliveHandle) { clearInterval(keepAliveHandle); keepAliveHandle = null; }
  if (syncCheckHandle) { clearInterval(syncCheckHandle); syncCheckHandle = null; }
  syncClient = null;
  running = false;
  consecutiveUnhealthy = 0;
  console.error("[autoSync] Stopped");
}

export function isAutoSyncRunning(): boolean {
  return running;
}

export function getAutoSyncState(): string | null {
  return syncClient?.getSyncState() ?? null;
}

/**
 * Get the sync client for sending read receipts.
 * Returns null if autoSync is not running.
 */
export function getSyncClient(): MatrixClient | null {
  return syncClient;
}

export interface SyncHealth {
  running: boolean;
  state: string;
  consecutiveUnhealthy: number;
  totalReconnects: number;
  lastReconnectSecondsAgo: number | null;
  lastEventSecondsAgo: number | null;
  stale: boolean;
}

export function getSyncHealth(): SyncHealth {
  const metrics = getMetrics();
  const lastEventAge = metrics.lastEventAt ? Math.round((Date.now() - metrics.lastEventAt) / 1000) : null;
  const syncState = syncClient?.getSyncState() ?? null;
  const isHealthyState = syncState === "SYNCING" || syncState === "PREPARED";

  return {
    running,
    state: syncState ?? "not_started",
    consecutiveUnhealthy,
    totalReconnects,
    lastReconnectSecondsAgo: lastReconnectAt ? Math.round((Date.now() - lastReconnectAt) / 1000) : null,
    lastEventSecondsAgo: lastEventAge,
    stale: isHealthyState && lastEventAge !== null && lastEventAge * 1000 > STALE_WARN_THRESHOLD_MS,
  };
}
