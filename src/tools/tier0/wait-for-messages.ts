import { z } from "zod";
import { RoomEvent, MatrixEvent, EventType, ClientEvent } from "matrix-js-sdk";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const DEBOUNCE_MS = 500;
const REACTION_DEBOUNCE_MS = 2 * 60 * 1000; // 2 minutes — batch reactions before waking up
const SYNC_CHECK_INTERVAL_MS = 3 * 60 * 1000; // Check sync health every 3 minutes
const DATA_DIR = process.env.MATRIX_DATA_DIR ?? path.join(process.cwd(), ".data");
mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, "sync-state.json");

// Internal cursor: tracks the last message we returned, so the catch-up scan
// works even when the caller doesn't pass a `since` token.
// Persisted to STATE_FILE so it survives server restarts.
let lastSeenEventId: string | undefined;
let lastSeenTimestamp = 0;
let persistedSyncToken: string | undefined;

// Load persisted cursor on module startup
try {
  const saved = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  if (saved.lastSeenTimestamp) lastSeenTimestamp = saved.lastSeenTimestamp;
  if (saved.lastSeenEventId) lastSeenEventId = saved.lastSeenEventId;
  if (saved.syncToken) persistedSyncToken = saved.syncToken;
} catch {
  // No state file yet — start fresh
}

function updateInternalCursor(eventId: string, timestamp: number) {
  if (timestamp > lastSeenTimestamp || (timestamp === lastSeenTimestamp && eventId !== lastSeenEventId)) {
    lastSeenEventId = eventId;
    lastSeenTimestamp = timestamp;
    try {
      writeFileSync(STATE_FILE, JSON.stringify({ lastSeenEventId, lastSeenTimestamp, syncToken: persistedSyncToken }));
    } catch {
      // Non-fatal — in-memory cursor still works
    }
  }
}

function updateSyncToken(token: string | null) {
  if (!token || token === persistedSyncToken) return;
  persistedSyncToken = token;
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ lastSeenEventId, lastSeenTimestamp, syncToken: persistedSyncToken }));
  } catch {
    // Non-fatal
  }
}

interface CollectedMessage {
  roomId: string;
  roomName: string;
  sender: string;
  body: string;
  eventId: string;
  timestamp: number;
  isDM: boolean;
  threadRootEventId?: string;
  replyToEventId?: string;
}

interface CollectedReaction {
  roomId: string;
  roomName: string;
  sender: string;
  emoji: string;
  reactedToEventId: string;
  eventId: string;
  timestamp: number;
}

export const waitForMessagesHandler = async (
  { roomId, timeoutMs, since }: { roomId?: string; timeoutMs: number; since?: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  // Clamp: minimum 1s, maximum 2^31-1 ms (setTimeout overflows above this)
  const timeout = Math.min(Math.max(timeoutMs, 1000), 2147483647);

  // Parse the continuation token: "eventId|timestamp"
  // Fall back to the internal cursor if the caller doesn't provide one.
  let sinceTimestamp = 0;
  let sinceEventId: string | undefined;
  if (since) {
    const parts = since.split("|");
    if (parts.length === 2) {
      sinceEventId = parts[0];
      sinceTimestamp = parseInt(parts[1], 10) || 0;
    }
  } else if (lastSeenTimestamp) {
    sinceTimestamp = lastSeenTimestamp;
    sinceEventId = lastSeenEventId;
  }

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken, persistedSyncToken);
    const ownUserId = client.getUserId();

    // Persist the current sync token so the next client creation can resume from here.
    updateSyncToken(client.store.getSyncToken());

    // Build DM room set from m.direct account data event.
    // Build DM room set: m.direct account data + fallback (2-member private room).
    const mDirectContent = (client.getAccountData(EventType.Direct) as any)?.getContent() ?? {};
    const dmRoomIds = new Set<string>(Object.values(mDirectContent).flat() as string[]);
    // Fallback: rooms with exactly 2 joined members and no public join rule are likely DMs.
    for (const room of client.getRooms()) {
      if (!dmRoomIds.has(room.roomId)) {
        const joinRule = room.currentState.getStateEvents("m.room.join_rules", "")?.getContent()?.join_rule;
        if (joinRule !== "public" && room.getJoinedMemberCount() === 2) {
          dmRoomIds.add(room.roomId);
        }
      }
    }

    const collected: CollectedMessage[] = [];
    const collectedReactions: CollectedReaction[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // Dedup set shared between catch-up scan and live listener
    const seenEventIds = new Set<string>();

    // --- Collect pending room invites ---
    const pendingInvites = client.getRooms()
      .filter((r) => r.getMyMembership() === "invite")
      .map((room: any) => {
        const member = room.currentState.getMember(ownUserId || "");
        const invitedBy = member?.events?.member?.getSender() ?? "unknown";
        return { roomId: room.roomId, roomName: room.name || room.roomId, invitedBy };
      });

    // Since cursor baseline
    const catchupSinceTs = sinceTimestamp > 0 ? sinceTimestamp : Date.now() - 15 * 60 * 1000;
    const catchupSinceId = sinceTimestamp > 0 ? sinceEventId : undefined;

    const liveReactions: CollectedReaction[] = [];

    const result = await new Promise<{ messages: CollectedMessage[]; reactions: CollectedReaction[]; timedOut: boolean; syncStale?: boolean; reactionsOnly?: boolean }>((resolve) => {
      let reactionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      // Live mode is inactive during the synchronous catch-up scan; enabled after.
      let liveModeActive = false;

      const onEvent = (event: MatrixEvent) => {
        const evtRoomId = event.getRoomId();
        if (roomId && evtRoomId !== roomId) return;

        // Reactions on own messages — collect for 2-min digest (live mode only)
        if (event.getType() === "m.reaction") {
          if (!liveModeActive) return;
          const relatesTo = event.getContent()?.["m.relates_to"];
          if (relatesTo?.rel_type === "m.annotation" && relatesTo.key && relatesTo.event_id) {
            const targetEvent = evtRoomId ? client.getRoom(evtRoomId)?.findEventById(relatesTo.event_id) : null;
            if (targetEvent?.getSender() === ownUserId) {
              const room = evtRoomId ? client.getRoom(evtRoomId) : null;
              liveReactions.push({
                roomId: evtRoomId || "",
                roomName: room?.name || evtRoomId || "",
                sender: event.getSender() || "",
                emoji: relatesTo.key,
                reactedToEventId: relatesTo.event_id,
                eventId: event.getId() || "",
                timestamp: event.getTs(),
              });
              // Start/reset 2-min reaction debounce
              if (reactionDebounceTimer) clearTimeout(reactionDebounceTimer);
              reactionDebounceTimer = setTimeout(() => {
                cleanup();
                resolve({ messages: collected, reactions: [...collectedReactions, ...liveReactions], timedOut: false, reactionsOnly: true });
              }, REACTION_DEBOUNCE_MS);
            }
          }
          return;
        }

        // Only m.room.message events from here
        if (event.getType() !== EventType.RoomMessage) return;
        if (event.getSender() === ownUserId) return;

        // Skip events at or before the catch-up baseline
        const ts = event.getTs();
        const eid = event.getId();
        if (ts < catchupSinceTs) return;
        if (ts === catchupSinceTs && eid === catchupSinceId) return;

        const content = event.getContent();
        const relatesTo = content?.["m.relates_to"];
        if (relatesTo?.rel_type === "m.replace") return;
        if (event.isRedacted()) return;

        // Dedup: the catch-up scan and live listener share seenEventIds
        if (!eid || seenEventIds.has(eid)) return;
        seenEventIds.add(eid);

        const room = evtRoomId ? client.getRoom(evtRoomId) : null;
        collected.push({
          roomId: evtRoomId || "",
          roomName: room?.name || evtRoomId || "",
          sender: event.getSender() || "",
          body: String(content?.body || ""),
          eventId: eid,
          timestamp: ts,
          isDM: dmRoomIds.has(evtRoomId || ""),
          threadRootEventId: relatesTo?.rel_type === "io.element.thread" || relatesTo?.rel_type === "m.thread"
            ? relatesTo.event_id : undefined,
          replyToEventId: relatesTo?.["m.in_reply_to"]?.event_id,
        });

        if (!liveModeActive) return; // collected during catch-up scan; resolve handled below

        // Message arrived in live mode — cancel reaction debounce, resolve now
        if (reactionDebounceTimer) clearTimeout(reactionDebounceTimer);
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          cleanup();
          resolve({ messages: collected, reactions: [...collectedReactions, ...liveReactions], timedOut: false });
        }, DEBOUNCE_MS);
      };

      // Live invite detection: resolve when a new room invite arrives during the wait
      const onRoom = (room: any) => {
        if (!liveModeActive) return;
        if (room.getMyMembership() !== "invite") return;
        const member = room.currentState?.getMember(ownUserId || "");
        const invitedBy = member?.events?.member?.getSender() ?? "unknown";
        pendingInvites.push({ roomId: room.roomId, roomName: room.name || room.roomId, invitedBy });
        cleanup();
        resolve({ messages: collected, reactions: [...collectedReactions, ...liveReactions], timedOut: false });
      };

      const timeoutHandle = setTimeout(() => {
        cleanup();
        resolve({ messages: collected, reactions: [...collectedReactions, ...liveReactions], timedOut: true });
      }, timeout);

      const syncCheckHandle = setInterval(() => {
        const state = client.getSyncState();
        if (state === "STOPPED" || state === null) {
          cleanup();
          resolve({ messages: collected, reactions: [...collectedReactions, ...liveReactions], timedOut: false, syncStale: true });
        }
      }, SYNC_CHECK_INTERVAL_MS);

      function cleanup() {
        client.removeListener(RoomEvent.Timeline, onEvent);
        client.removeListener(ClientEvent.Room, onRoom);
        clearTimeout(timeoutHandle);
        clearInterval(syncCheckHandle);
        if (debounceTimer) clearTimeout(debounceTimer);
        if (reactionDebounceTimer) clearTimeout(reactionDebounceTimer);
      }

      // Register listener FIRST — before the catch-up scan — so any event that fires
      // during the synchronous scan is collected (deduped by seenEventIds).
      client.on(RoomEvent.Timeline, onEvent);
      client.on(ClientEvent.Room, onRoom);

      // --- Catch-up scan: check existing timeline for events newer than the since cursor ---
      // Runs synchronously (no await), so the event loop cannot interrupt it.
      // On fresh start / after restart, uses a 15-minute lookback.
      {
        const roomsToScan = roomId
          ? [client.getRoom(roomId)].filter(Boolean)
          : client.getRooms();

        for (const room of roomsToScan) {
          if (!room) continue;
          const events = room.getLiveTimeline().getEvents();
          for (const event of events) {
            const ts = event.getTs();
            const eid = event.getId();
            if (ts < catchupSinceTs) continue;
            if (ts === catchupSinceTs && eid === catchupSinceId) continue;

            // Reactions: collect for context
            if (event.getType() === "m.reaction") {
              const relatesTo = event.getContent()?.["m.relates_to"];
              if (relatesTo?.rel_type === "m.annotation" && relatesTo.key && relatesTo.event_id) {
                collectedReactions.push({
                  roomId: event.getRoomId() || "",
                  roomName: room.name || event.getRoomId() || "",
                  sender: event.getSender() || "",
                  emoji: relatesTo.key,
                  reactedToEventId: relatesTo.event_id,
                  eventId: eid || "",
                  timestamp: ts,
                });
              }
              continue;
            }

            if (event.getType() !== EventType.RoomMessage) continue;
            if (event.getSender() === ownUserId) continue;

            const content = event.getContent();
            const relatesTo = content?.["m.relates_to"];
            if (relatesTo?.rel_type === "m.replace") continue;
            if (event.isRedacted()) continue;

            if (!eid || seenEventIds.has(eid)) continue;
            seenEventIds.add(eid);
            collected.push({
              roomId: event.getRoomId() || "",
              roomName: room.name || event.getRoomId() || "",
              sender: event.getSender() || "",
              body: String(content?.body || ""),
              eventId: eid,
              timestamp: ts,
              isDM: dmRoomIds.has(event.getRoomId() || ""),
              threadRootEventId: relatesTo?.rel_type === "io.element.thread" || relatesTo?.rel_type === "m.thread"
                ? relatesTo.event_id : undefined,
              replyToEventId: relatesTo?.["m.in_reply_to"]?.event_id,
            });
          }
        }
      }

      // If catch-up found messages (or invites), return immediately.
      if (collected.length > 0 || pendingInvites.length > 0) {
        collected.sort((a, b) => a.timestamp - b.timestamp);
        cleanup();
        resolve({ messages: collected, reactions: collectedReactions, timedOut: false });
        return;
      }

      // No catch-up messages — switch to live mode. Listener is already registered.
      liveModeActive = true;
    });

    // Keep the sync token current after each wait cycle.
    updateSyncToken(client.store.getSyncToken());

    // Build continuation token from the last message (reactions don't advance cursor)
    let nextSince: string | undefined;
    if (result.messages.length > 0) {
      const last = result.messages[result.messages.length - 1];
      updateInternalCursor(last.eventId, last.timestamp);
      nextSince = `${last.eventId}|${last.timestamp}`;
    } else if (since) {
      nextSince = since;
    }

    const reactionPayload = result.reactions.length > 0 ? { reactions: result.reactions.map((r) => ({
      room: r.roomName,
      roomId: r.roomId,
      sender: r.sender,
      emoji: r.emoji,
      reactedToEventId: r.reactedToEventId,
      eventId: r.eventId,
      timestamp: new Date(r.timestamp).toISOString(),
    })) } : {};

    if (result.messages.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.syncStale ? "sync_stale" : result.reactionsOnly ? "reactions_received" : result.timedOut ? "timeout" : "no_messages",
              messages: [],
              messageCount: 0,
              ...(pendingInvites.length > 0 ? { invites: pendingInvites } : {}),
              ...reactionPayload,
              ...(nextSince ? { since: nextSince } : {}),
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "messages_received",
            messageCount: result.messages.length,
            messages: result.messages.map((m) => ({
              room: m.roomName,
              roomId: m.roomId,
              sender: m.sender,
              body: m.body,
              eventId: m.eventId,
              timestamp: new Date(m.timestamp).toISOString(),
              isDM: m.isDM,
              ...(m.threadRootEventId ? { threadRootEventId: m.threadRootEventId } : {}),
              ...(m.replyToEventId ? { replyToEventId: m.replyToEventId } : {}),
            })),
            ...(pendingInvites.length > 0 ? { invites: pendingInvites } : {}),
            ...reactionPayload,
            since: nextSince,
          }),
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed in wait-for-messages: ${error.message}`);
    removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: Failed to wait for messages - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

export const registerWaitForMessagesTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "wait-for-messages",
    {
      title: "Wait for New Matrix Messages",
      description:
        "Wait for new incoming messages in real time, including direct messages. " +
        "Watches all joined rooms by default, or a specific room if roomId is provided. " +
        "Returns as soon as messages arrive (with batching) or when the timeout expires. " +
        "Use the returned `since` token on subsequent calls to avoid duplicates. " +
        "More efficient than polling get-room-messages repeatedly.",
      inputSchema: {
        roomId: z
          .string()
          .optional()
          .describe("Matrix room ID to watch. Omit to watch all joined rooms including DMs."),
        timeoutMs: z
          .number()
          .default(DEFAULT_TIMEOUT_MS)
          .describe("How long to wait in milliseconds (default 30 seconds, no upper limit)"),
        since: z
          .string()
          .optional()
          .describe("Continuation token from a previous wait-for-messages call"),
      },
    },
    waitForMessagesHandler
  );
};
