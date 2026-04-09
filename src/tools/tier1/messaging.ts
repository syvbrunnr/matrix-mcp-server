import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createCipheriv, createHash, randomBytes } from "crypto";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache, getDiagnosticHint } from "../../utils/matrix-errors.js";
import { resolveThreadRoot, buildRelatesTo } from "../../utils/threading.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

/** Encode Buffer as unpadded base64url (for JWK key.k). */
function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Encode Buffer as unpadded standard base64 (for Matrix EncryptedFile iv and hashes). */
function base64Unpadded(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "");
}

/** Matrix EncryptedFile format (MSC3246 / matrix spec v1.8). */
interface EncryptedFile {
  v: "v2";
  url: string;
  key: {
    kty: "oct";
    alg: "A256CTR";
    ext: true;
    k: string;
    key_ops: string[];
  };
  iv: string;
  hashes: { sha256: string };
  mimetype?: string;
}

/** Encrypt an attachment buffer for upload to an E2EE room.
 *  Returns { ciphertext, file } where file contains key material and hashes.
 *  Uses AES-256-CTR per Matrix spec. The counter starts at 0; Matrix spec
 *  requires the high 64 bits of the IV to be the nonce and the low 64 bits
 *  to be the counter (which starts at 0).
 */
function encryptAttachment(plaintext: Buffer): {
  ciphertext: Buffer;
  file: Omit<EncryptedFile, "url" | "mimetype">;
} {
  const keyBytes = randomBytes(32); // AES-256 key
  // Matrix spec: IV is 16 bytes; the low 8 bytes are the counter (start at 0).
  // Generate 8 random bytes for the high nonce, zero the counter half.
  const ivBytes = Buffer.alloc(16);
  randomBytes(8).copy(ivBytes, 0);
  // Bytes 8..15 remain zero (counter starts at 0).

  const cipher = createCipheriv("aes-256-ctr", keyBytes, ivBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sha256 = createHash("sha256").update(ciphertext).digest();

  return {
    ciphertext,
    file: {
      v: "v2",
      key: {
        kty: "oct",
        alg: "A256CTR",
        ext: true,
        k: base64UrlEncode(keyBytes), // JWK: url-safe unpadded
        key_ops: ["encrypt", "decrypt"],
      },
      iv: base64Unpadded(ivBytes), // Matrix spec: standard unpadded base64
      hashes: { sha256: base64Unpadded(sha256) }, // Matrix spec: standard unpadded base64
    },
  };
}

/** Extract image dimensions (width, height) from image buffer.
 *  Supports PNG, JPEG, GIF, and WebP. Returns null if format unknown or buffer too small.
 *  Element Desktop requires info.w/info.h for inline preview rendering.
 */
function getImageDimensions(buffer: Buffer): { w: number; h: number } | null {
  if (buffer.length < 24) return null;

  // PNG: 8-byte signature + IHDR chunk with w/h at offset 16/20 (big-endian u32).
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return {
      w: buffer.readUInt32BE(16),
      h: buffer.readUInt32BE(20),
    };
  }

  // GIF: "GIF87a" or "GIF89a" + w/h at offset 6/8 (little-endian u16).
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return {
      w: buffer.readUInt16LE(6),
      h: buffer.readUInt16LE(8),
    };
  }

  // JPEG: starts with 0xFFD8, scan for SOF0/SOF2 marker (0xFFC0/0xFFC2).
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const segmentLen = buffer.readUInt16BE(offset + 2);
      // SOF markers: C0-CF except C4 (DHT), C8 (JPG), CC (DAC)
      if (
        (marker >= 0xc0 && marker <= 0xcf) &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        return {
          h: buffer.readUInt16BE(offset + 5),
          w: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + segmentLen;
    }
  }

  // WebP: "RIFF" + 4 bytes + "WEBP". VP8/VP8L/VP8X chunks carry the dimensions.
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    const chunkType = buffer.slice(12, 16).toString("ascii");
    if (chunkType === "VP8L" && buffer.length >= 30) {
      // VP8L: 1-byte signature then 14 bits width-1, 14 bits height-1.
      const b0 = buffer[21];
      const b1 = buffer[22];
      const b2 = buffer[23];
      const b3 = buffer[24];
      return {
        w: (((b1 & 0x3f) << 8) | b0) + 1,
        h: (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) + 1,
      };
    }
    if (chunkType === "VP8X" && buffer.length >= 30) {
      // VP8X: 4-byte flags then 3-byte (w-1) then 3-byte (h-1), little-endian.
      const w = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const h = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return { w, h };
    }
    if (chunkType === "VP8 " && buffer.length >= 30) {
      // VP8 lossy: frame tag at offset 20, dimensions at offset 26.
      return {
        w: buffer.readUInt16LE(26) & 0x3fff,
        h: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }

  return null;
}

/** Strip HTML tags to produce a plaintext fallback body for Matrix messages. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Tool: Send message
export const sendMessageHandler = async (
  { roomId, message, messageType, replyToEventId, threadRootEventId }: {
    roomId: string;
    message: string;
    messageType: "text" | "html" | "emote";
    replyToEventId?: string;
    threadRootEventId?: string;
  },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    
    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Room with ID ${roomId} not found. You may not be a member of this room.`,
          },
        ],
        isError: true,
      };
    }

    // Check if user can send messages
    const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
    const userPowerLevel = room.getMember(matrixUserId)?.powerLevel || 0;
    const requiredLevel = powerLevelEvent?.getContent()?.events?.["m.room.message"] || 0;
    
    if (userPowerLevel < requiredLevel) {
      return {
        content: [
          {
            type: "text",
            text: `Error: You don't have permission to send messages in this room. Required power level: ${requiredLevel}, your level: ${userPowerLevel}`,
          },
        ],
        isError: true,
      };
    }

    const effectiveThreadRoot = resolveThreadRoot(room, replyToEventId, threadRootEventId);
    const relatesTo = buildRelatesTo(effectiveThreadRoot, replyToEventId);

    let response;
    if (relatesTo) {
      // Use sendMessage for structured content (threads/replies)
      const msgtype = messageType === "html" ? "m.text"
        : messageType === "emote" ? "m.emote"
        : "m.text";
      const content: Record<string, any> = {
        msgtype,
        body: messageType === "html" ? stripHtml(message) : message,
        "m.relates_to": relatesTo,
      };
      if (messageType === "html") {
        content.format = "org.matrix.custom.html";
        content.formatted_body = message;
      }
      response = await client.sendEvent(roomId, "m.room.message" as any, content as any);
    } else if (messageType === "html") {
      response = await client.sendHtmlMessage(roomId, stripHtml(message), message);
    } else if (messageType === "emote") {
      response = await client.sendEmoteMessage(roomId, message);
    } else {
      response = await client.sendTextMessage(roomId, message);
    }

    const extras = [
      replyToEventId ? `reply to ${replyToEventId}` : "",
      effectiveThreadRoot ? `thread ${effectiveThreadRoot}` : "",
    ].filter(Boolean).join(", ");

    return {
      content: [
        {
          type: "text",
          text: `Message sent successfully to ${room.name || roomId}
Event ID: ${response.event_id}
Message type: ${messageType}${extras ? ` (${extras})` : ""}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to send message: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text",
          text: `Error: Failed to send message - ${error.message}\n${getDiagnosticHint(error)}`,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Send direct message
export const sendDirectMessageHandler = async (
  { targetUserId, message, messageType, replyToEventId }: {
    targetUserId: string;
    message: string;
    messageType: "text" | "html" | "emote";
    replyToEventId?: string;
  },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);
  
  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    
    // First, try to find an existing DM room
    const rooms = client.getRooms();
    let dmRoom = rooms.find((room) => {
      const members = room.getJoinedMembers();
      return (
        members.length === 2 &&
        members.some((member) => member.userId === targetUserId) &&
        members.some((member) => member.userId === matrixUserId)
      );
    });

    let roomId: string;
    
    if (dmRoom) {
      // Use existing DM room
      roomId = dmRoom.roomId;
    } else {
      // Create new DM room with encryption enabled (matches Element's default behavior)
      const createResponse = await client.createRoom({
        is_direct: true,
        invite: [targetUserId],
        preset: "trusted_private_chat" as any,
        initial_state: [
          {
            type: "m.room.encryption",
            state_key: "",
            content: {
              algorithm: "m.megolm.v1.aes-sha2",
            },
          },
          {
            type: "m.room.guest_access",
            content: {
              guest_access: "forbidden",
            },
          },
        ],
      });
      roomId = createResponse.room_id;
      
      // Mark as DM in account data
      try {
        const existingDmEvent = client.getAccountData("m.direct" as any) as any;
        const existingDmContent = existingDmEvent?.getContent?.() ?? existingDmEvent ?? {};
        const dmData: { [key: string]: string[] } = {};
        // Safely extract only valid room ID arrays from m.direct content
        for (const [userId, rooms] of Object.entries(existingDmContent)) {
          if (Array.isArray(rooms)) {
            dmData[userId] = rooms.filter((r): r is string => typeof r === "string" && r.startsWith("!"));
          }
        }
        if (!dmData[targetUserId]) {
          dmData[targetUserId] = [];
        }
        dmData[targetUserId].push(roomId);
        await client.setAccountData("m.direct" as any, dmData as any);
      } catch (error) {
        console.warn("Could not update m.direct account data:", error);
      }
    }

    // Send the message with formatting and reply support
    let response;
    const relatesTo = replyToEventId ? { "m.in_reply_to": { event_id: replyToEventId } } : undefined;

    if (relatesTo) {
      const msgtype = messageType === "emote" ? "m.emote" : "m.text";
      const content: Record<string, any> = {
        msgtype,
        body: messageType === "html" ? stripHtml(message) : message,
        "m.relates_to": relatesTo,
      };
      if (messageType === "html") {
        content.format = "org.matrix.custom.html";
        content.formatted_body = message;
      }
      response = await client.sendEvent(roomId, "m.room.message" as any, content as any);
    } else if (messageType === "html") {
      response = await client.sendHtmlMessage(roomId, stripHtml(message), message);
    } else if (messageType === "emote") {
      response = await client.sendEmoteMessage(roomId, message);
    } else {
      response = await client.sendTextMessage(roomId, message);
    }

    // Get room info for response
    const finalRoom = client.getRoom(roomId) || dmRoom;
    const roomName = finalRoom?.name || `DM with ${targetUserId}`;

    return {
      content: [
        {
          type: "text",
          text: `Direct message sent successfully to ${targetUserId}
Room: ${roomName} (${roomId})
Event ID: ${response.event_id}
Message type: ${messageType}${replyToEventId ? ` (reply to ${replyToEventId})` : ""}
${!dmRoom ? "New DM room created" : "Used existing DM room"}`,
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed to send direct message: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    
    // Provide more specific error messages
    let errorMessage = `Error: Failed to send direct message - ${error.message}`;
    if (error.message.includes("not found") || error.message.includes("M_NOT_FOUND")) {
      errorMessage = `Error: User ${targetUserId} not found or not accessible from your homeserver`;
    } else if (error.message.includes("forbidden") || error.message.includes("M_FORBIDDEN")) {
      errorMessage = `Error: Cannot send direct message to ${targetUserId} - they may have blocked DMs or be on a different homeserver`;
    }
    errorMessage += `\n${getDiagnosticHint(error)}`;

    return {
      content: [
        {
          type: "text",
          text: errorMessage,
        },
      ],
      isError: true,
    };
  }
};

// Tool: Send image
export const sendImageHandler = async (
  { roomId, imageBase64, mimeType, filename, body, replyToEventId, threadRootEventId }: {
    roomId: string;
    imageBase64: string;
    mimeType?: string;
    filename?: string;
    body?: string;
    replyToEventId?: string;
    threadRootEventId?: string;
  },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [{ type: "text", text: `Error: Room with ID ${roomId} not found.` }],
        isError: true,
      };
    }

    // Decode base64 to buffer.
    const buffer = Buffer.from(imageBase64, "base64");
    const effectiveMime = mimeType || "image/png";
    const effectiveFilename = filename || "image.png";

    // For E2EE rooms, media must also be encrypted. Element Desktop refuses
    // to render plaintext media URLs in encrypted rooms (info-leak protection).
    const isEncryptedRoom = room.hasEncryptionStateEvent();

    let mxcUrl: string;
    let encryptedFile: Omit<EncryptedFile, "url" | "mimetype"> | null = null;

    let thumbnailFile: EncryptedFile | null = null;

    if (isEncryptedRoom) {
      const { ciphertext, file } = encryptAttachment(buffer);
      // Upload the ciphertext as application/octet-stream — Matrix content repo
      // should not treat it as a renderable image type.
      // Cast to any because matrix-js-sdk's FileType uses browser DOM types
      // (XMLHttpRequestBodyInit) which don't formally include Node Buffer, but
      // the SDK handles Buffer correctly at runtime (same as the plaintext path).
      const uploadResponse = await client.uploadContent(ciphertext as any, {
        type: "application/octet-stream",
        name: effectiveFilename,
      });
      mxcUrl = uploadResponse.content_uri;
      encryptedFile = file;

      // Element Desktop requires info.thumbnail_file to render inline previews
      // in encrypted rooms (mobile Element is lenient and falls back to the
      // main file). Without a proper image library to generate a real
      // downscaled thumbnail, we re-encrypt the original buffer with a fresh
      // key and upload it as the thumbnail. For small images (QR codes, icons)
      // this is correct behavior; for larger photos this wastes bandwidth but
      // is functionally fine until sharp/jimp is added.
      const thumbEncrypted = encryptAttachment(buffer);
      const thumbUpload = await client.uploadContent(thumbEncrypted.ciphertext as any, {
        type: "application/octet-stream",
        name: `thumb-${effectiveFilename}`,
      });
      thumbnailFile = {
        ...thumbEncrypted.file,
        url: thumbUpload.content_uri,
        mimetype: effectiveMime,
      };
    } else {
      const uploadResponse = await client.uploadContent(buffer, {
        type: effectiveMime,
        name: effectiveFilename,
      });
      mxcUrl = uploadResponse.content_uri;
    }

    // Build m.image event content.
    const info: Record<string, any> = {
      mimetype: effectiveMime,
      size: buffer.length,
    };
    // Element Desktop requires w/h in info to render inline preview.
    // Auto-detect from common image formats (PNG, JPEG, GIF, WebP).
    const dims = getImageDimensions(buffer);
    if (dims) {
      info.w = dims.w;
      info.h = dims.h;
    }
    if (thumbnailFile) {
      info.thumbnail_file = thumbnailFile;
      info.thumbnail_info = {
        mimetype: effectiveMime,
        size: buffer.length,
        ...(dims ? { w: dims.w, h: dims.h } : {}),
      };
    }
    const content: Record<string, any> = {
      msgtype: "m.image",
      body: body || effectiveFilename,
      info,
    };
    if (encryptedFile) {
      // Encrypted rooms use `file` with key material; no top-level `url`.
      content.file = { ...encryptedFile, url: mxcUrl, mimetype: effectiveMime };
    } else {
      content.url = mxcUrl;
    }

    const effectiveThreadRoot = resolveThreadRoot(room, replyToEventId, threadRootEventId);
    const relatesTo = buildRelatesTo(effectiveThreadRoot, replyToEventId);
    if (relatesTo) {
      content["m.relates_to"] = relatesTo;
    }

    const response = await client.sendEvent(roomId, "m.room.message" as any, content as any);

    return {
      content: [{
        type: "text",
        text: `Image sent successfully to ${room.name || roomId}\nEvent ID: ${response.event_id}\nMXC URL: ${mxcUrl}\nSize: ${buffer.length} bytes`,
      }],
    };
  } catch (error: any) {
    console.error(`Failed to send image: ${error.message}`);
    if (shouldEvictClientCache(error)) removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [{ type: "text", text: `Error: Failed to send image - ${error.message}\n${getDiagnosticHint(error)}` }],
      isError: true,
    };
  }
};

// Registration function
export const registerMessagingTools: ToolRegistrationFunction = (server) => {
  // Tool: Send message
  server.registerTool(
    "send-message",
    {
      title: "Send Matrix Message",
      description:
        "Send a text message to a Matrix room, with support for plain text, HTML formatting, replies, and threads. " +
        "Use replyToEventId to quote-reply to a specific message. " +
        "Use threadRootEventId to send a message in a thread (the root event ID starts the thread). " +
        "You can combine both to reply to a specific message within a thread. " +
        "Get eventIds from get-room-messages or wait-for-messages. " +
        "Auto-threading: In group rooms (3+ members), using replyToEventId automatically creates or joins a thread. " +
        "If the target message is in a thread, the reply stays in that thread. " +
        "If the target message is standalone, a new thread is started. " +
        "In DMs (2 members), replyToEventId creates an inline reply without threading.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        message: z.string().describe("The message content to send"),
        messageType: z
          .enum(["text", "html", "emote"])
          .default("text")
          .describe("Type of message: text (plain), html (formatted), or emote (action)"),
        replyToEventId: z
          .string()
          .optional()
          .describe("Event ID to reply to. Get this from the eventId field in get-room-messages or wait-for-messages results."),
        threadRootEventId: z
          .string()
          .optional()
          .describe("Event ID of the thread root to send this message as part of a thread. " +
            "If the message you want to reply to has a threadRootEventId, use that value here to stay in the same thread."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    sendMessageHandler
  );

  // Tool: Send direct message
  server.registerTool(
    "send-direct-message",
    {
      title: "Send Direct Message",
      description: "Send a direct message to a Matrix user. Creates a new DM room if one doesn't exist. " +
        "Supports plain text, HTML formatting, emotes, and inline replies. " +
        "Note: E2EE message content in DMs may be undecryptable on some homeservers (e.g., Dendrite) due to device key sharing limitations.",
      inputSchema: {
        targetUserId: z
          .string()
          .describe("Target user's Matrix ID (e.g., @user:domain.com)"),
        message: z.string().describe("The message content to send"),
        messageType: z
          .enum(["text", "html", "emote"])
          .default("text")
          .describe("Type of message: text (plain), html (formatted), or emote (action)"),
        replyToEventId: z
          .string()
          .optional()
          .describe("Event ID to reply to within the DM conversation"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    sendDirectMessageHandler
  );

  // Tool: Send image
  server.registerTool(
    "send-image",
    {
      title: "Send Image to Matrix Room",
      description:
        "Upload and send an image to a Matrix room. Accepts base64-encoded image data. " +
        "Supports threading and replies like send-message. " +
        "The image is uploaded to the Matrix content repository and sent as an m.image event.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        imageBase64: z.string().describe("Base64-encoded image data (no data: prefix)"),
        mimeType: z
          .string()
          .default("image/png")
          .optional()
          .describe("MIME type of the image (default: image/png)"),
        filename: z
          .string()
          .default("image.png")
          .optional()
          .describe("Filename for the uploaded image (default: image.png)"),
        body: z
          .string()
          .optional()
          .describe("Alt text / body for the image message"),
        replyToEventId: z
          .string()
          .optional()
          .describe("Event ID to reply to"),
        threadRootEventId: z
          .string()
          .optional()
          .describe("Event ID of the thread root"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    sendImageHandler
  );
};