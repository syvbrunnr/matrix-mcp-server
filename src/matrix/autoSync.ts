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
import { RoomEvent, MatrixEvent, EventType, ClientEvent, MatrixClient, ThreadEvent } from "matrix-js-sdk";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../utils/server-helpers.js";
import { getMessageQueue, QueuedMessage } from "./messageQueue.js";
import { getCachedClient } from "./clientCache.js";
import { readFileSync } from "fs";
import path from "path";
import { increment, getMetrics, resetStalenessBaseline } from "./pipelineMetrics.js";
import { buildDmRoomSet, extractQueuedMessage, handleEditEvent, scheduleDecryptionRetries } from "./syncEventHandlers.js";

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

      // For encrypted messages, set up decryption recovery (event listener + timed retries)
      if (enqueued && msg.decryptionFailed) {
        scheduleDecryptionRetries(event, msg.eventId, client, queue);
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
            scheduleDecryptionRetries(event, msg.eventId, client, queue);
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
  // Attach to newly joined rooms and rebuild DM set so new DMs are recognized immediately
  client.on(ClientEvent.Room, (room: any) => {
    attachThreadListener(room);
    dmRoomIds = buildDmRoomSet(client);
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
  keepAliveHandle = setInterval(async () => {
    getCachedClient(matrixUserId, homeserverUrl);
    const token = client.store.getSyncToken();
    if (token) queue.setSyncToken(token);
    dmRoomIds = buildDmRoomSet(client);
    queue.cleanup();

    // Crypto heartbeat: exercise the Olm send path on encrypted DM rooms.
    // Without periodic send-side activity, the Rust crypto module's Olm sessions
    // degrade after ~2h of receive-only operation (see friction:olm-session-degradation-idle).
    // prepareToEncrypt warms the session without actually sending a message.
    try {
      const crypto = client.getCrypto();
      if (crypto) {
        for (const rid of dmRoomIds) {
          const room = client.getRoom(rid);
          if (room && room.hasEncryptionStateEvent()) {
            try {
              crypto.prepareToEncrypt(room);
            } catch (_) { /* best-effort */ }
          }
        }
      }
    } catch (cryptoErr: any) {
      console.error(`[autoSync] Crypto heartbeat failed: ${cryptoErr.message}`);
    }

    // HTTP heartbeat: detect silent connection death.
    // NOTE: Do NOT call stopClient() here — it kills the crypto backend (cryptoBackend.stop())
    // and startClient() does NOT reinitialize it. This breaks inbound E2EE decryption permanently.
    // Instead, just log the failure and let the SDK's internal reconnection handle recovery.
    try {
      await Promise.race([
        client.whoami(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("whoami timeout")), 5_000)),
      ]);
    } catch (err: any) {
      console.error(`[autoSync] Heartbeat failed (${err.message}) — relying on SDK auto-reconnect`);
      totalReconnects++;
      lastReconnectAt = Date.now();
      resetStalenessBaseline();
    }
  }, KEEPALIVE_INTERVAL_MS);

  syncCheckHandle = setInterval(async () => {
    const state = client.getSyncState();
    const isUnhealthy = state === "STOPPED" || state === null || state === "ERROR";

    if (isUnhealthy) {
      consecutiveUnhealthy++;
      console.error(`[autoSync] Sync unhealthy (${state}), consecutive=${consecutiveUnhealthy}`);

      if (consecutiveUnhealthy >= MAX_UNHEALTHY_BEFORE_RESTART) {
        // NOTE: Do NOT call stopClient() — it kills crypto permanently.
        // Instead, try startClient() without stopping first. If sync is already
        // stopped, this should resume it. If it's in an error state, the SDK
        // should handle reconnection internally.
        console.error("[autoSync] Sync unhealthy, attempting resume without crypto disruption...");
        try {
          await client.startClient({ initialSyncLimit: 20, pollTimeout: 10_000 });
          totalReconnects++;
          lastReconnectAt = Date.now();
          consecutiveUnhealthy = 0;
          console.error("[autoSync] Sync resumed successfully");
        } catch (err: any) {
          console.error(`[autoSync] Sync resume failed: ${err.message}`);
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
        // Double the threshold = try to resume without killing crypto.
        // NOTE: stopClient() kills cryptoBackend.stop() permanently — never call it.
        console.error(`[autoSync] Stale for ${Math.round(silenceMs / 1000)}s — attempting resume`);
        try {
          await client.startClient({ initialSyncLimit: 20, pollTimeout: 10_000 });
          totalReconnects++;
          lastReconnectAt = Date.now();
          resetStalenessBaseline();
          console.error("[autoSync] Stale sync resumed successfully");
        } catch (err: any) {
          console.error(`[autoSync] Stale sync resume failed: ${err.message}`);
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
