import { z } from "zod";
import { encryptAttachment as meaEncryptAttachment } from "matrix-encrypt-attachment";
import sharp from "sharp";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { shouldEvictClientCache, getDiagnosticHint } from "../../utils/matrix-errors.js";
import { resolveThreadRoot, buildRelatesTo } from "../../utils/threading.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

/** Matrix EncryptedFile format (MSC3246 / matrix spec v1.8).
 *  Mirrors the structure from matrix-encrypt-attachment but exported here
 *  for convenience. */
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

/** Encrypt an attachment buffer via the official matrix-encrypt-attachment
 *  library. Matches Element Web's exact encryption path so any protocol-level
 *  issue is isolated from our crypto correctness. */
async function encryptAttachment(plaintext: Buffer): Promise<{
  ciphertext: Buffer;
  file: Omit<EncryptedFile, "url" | "mimetype">;
}> {
  // Copy into a fresh ArrayBuffer to satisfy the stricter matrix-encrypt-attachment
  // type signature (it expects ArrayBuffer, not ArrayBufferLike).
  const arrayBuffer = new ArrayBuffer(plaintext.byteLength);
  new Uint8Array(arrayBuffer).set(plaintext);
  const result = await meaEncryptAttachment(arrayBuffer);
  return {
    ciphertext: Buffer.from(result.data),
    file: result.info as Omit<EncryptedFile, "url" | "mimetype">,
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

/** Fetch an image from a URL and return its buffer + detected MIME type. */
async function fetchImageFromUrl(url: string): Promise<{ buffer: Buffer; detectedMime: string; detectedFilename: string }> {
  const response = await fetch(url, {
    headers: { "User-Agent": "matrix-mcp-server/1.0" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch image from URL: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const mime = contentType.split(";")[0].trim();
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Derive filename from URL path, falling back to a default.
  let detectedFilename = "image.jpg";
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).pop();
    if (lastSegment && /\.\w{2,5}$/.test(lastSegment)) {
      detectedFilename = lastSegment;
    }
  } catch { /* keep default */ }

  // Map common MIME types to file extensions if filename has no extension.
  const extMap: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
    "image/webp": ".webp", "image/svg+xml": ".svg",
  };
  if (!/\.\w{2,5}$/.test(detectedFilename) && extMap[mime]) {
    detectedFilename += extMap[mime];
  }

  return { buffer, detectedMime: mime, detectedFilename };
}

// Tool: Send image
export const sendImageHandler = async (
  { roomId, imageBase64, imageUrl, maxWidth, maxHeight, mimeType, filename, body, replyToEventId, threadRootEventId }: {
    roomId: string;
    imageBase64?: string;
    imageUrl?: string;
    maxWidth?: number;
    maxHeight?: number;
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

  if (!imageBase64 && !imageUrl) {
    return {
      content: [{ type: "text", text: "Error: Either imageBase64 or imageUrl must be provided." }],
      isError: true,
    };
  }

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);

    const room = client.getRoom(roomId);
    if (!room) {
      return {
        content: [{ type: "text", text: `Error: Room with ID ${roomId} not found.` }],
        isError: true,
      };
    }

    // Resolve image data from either base64 or URL.
    let buffer: Buffer;
    let autoMime: string | undefined;
    let autoFilename: string | undefined;

    if (imageUrl) {
      const fetched = await fetchImageFromUrl(imageUrl);
      buffer = fetched.buffer;
      autoMime = fetched.detectedMime;
      autoFilename = fetched.detectedFilename;
    } else {
      buffer = Buffer.from(imageBase64!, "base64");
    }
    // Resize if maxWidth or maxHeight specified.
    const origSize = buffer.length;
    if (maxWidth || maxHeight) {
      const resizeOpts: sharp.ResizeOptions = { fit: "inside", withoutEnlargement: true };
      let pipeline = sharp(buffer).resize(maxWidth || undefined, maxHeight || undefined, resizeOpts);
      // Re-encode to the source format (default JPEG for photos).
      const srcMime = mimeType || autoMime || "image/jpeg";
      if (srcMime === "image/png") {
        pipeline = pipeline.png();
      } else if (srcMime === "image/webp") {
        pipeline = pipeline.webp();
      } else {
        pipeline = pipeline.jpeg({ quality: 85 });
      }
      buffer = await pipeline.toBuffer();
      // Update auto-detected mime after resize if format changed.
      if (!mimeType && !autoMime) {
        autoMime = "image/jpeg";
      }
    }

    const effectiveMime = mimeType || autoMime || "image/png";
    const effectiveFilename = filename || autoFilename || "image.png";

    // For E2EE rooms, media must also be encrypted. Element Desktop refuses
    // to render plaintext media URLs in encrypted rooms (info-leak protection).
    const isEncryptedRoom = room.hasEncryptionStateEvent();

    let mxcUrl: string;
    let encryptedFile: Omit<EncryptedFile, "url" | "mimetype"> | null = null;

    let thumbnailFile: EncryptedFile | null = null;

    // Element Web skips thumbnail generation entirely for files under ~32KB.
    // For tiny images (icons, QR codes) an extra thumbnail is unnecessary and
    // may confuse strict clients that expect thumbnails only for large media.
    const SKIP_THUMBNAIL_BELOW = 32 * 1024;
    const shouldEmitThumbnail = buffer.length >= SKIP_THUMBNAIL_BELOW;

    if (isEncryptedRoom) {
      const { ciphertext, file } = await encryptAttachment(buffer);
      // Upload the ciphertext as application/octet-stream. Element Web also
      // passes includeFilename: false for encrypted uploads — the filename
      // shouldn't leak as metadata on the ciphertext URL (it's already in the
      // encrypted event). Cast to any because matrix-js-sdk's FileType uses
      // browser DOM types (XMLHttpRequestBodyInit) which don't formally
      // include Node Buffer, but the SDK handles Buffer correctly at runtime.
      const uploadResponse = await client.uploadContent(ciphertext as any, {
        type: "application/octet-stream",
        includeFilename: false,
      });
      mxcUrl = uploadResponse.content_uri;
      encryptedFile = file;

      // For larger images, generate a thumbnail entry. Without a real image
      // library (sharp/jimp) we re-encrypt the full buffer as the thumbnail.
      // Skipped for small images per Element Web's convention.
      if (shouldEmitThumbnail) {
        const thumbEncrypted = await encryptAttachment(buffer);
        const thumbUpload = await client.uploadContent(thumbEncrypted.ciphertext as any, {
          type: "application/octet-stream",
          includeFilename: false,
        });
        thumbnailFile = {
          ...thumbEncrypted.file,
          url: thumbUpload.content_uri,
          mimetype: effectiveMime,
        };
      }
    } else {
      const uploadResponse = await client.uploadContent(buffer as any, {
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
      // Element Web also sets thumbnail_url to the thumbnail's MXC URL even
      // for encrypted rooms (for legacy client compatibility). Element Desktop
      // appears to require thumbnail_url OR special handling without it.
      info.thumbnail_url = thumbnailFile.url;
      info.thumbnail_info = {
        mimetype: effectiveMime,
        size: buffer.length,
        ...(dims ? { w: dims.w, h: dims.h } : {}),
      };
    }
    // Element Web uses filename as body (not a description). This matches
    // the standard m.image body convention and helps clients identify it
    // as a renderable image vs a generic file attachment.
    // Element Web v1.11.85+ runs validateImageOrVideoMimetype() on every
    // m.image event and downgrades to MFileBody ("download attachment") when
    // `content.filename ?? content.body` has no recognised image extension.
    // Descriptive bodies like "Nordnet QR code" fail this gate.
    // Fix: always set `filename` explicitly. `body` becomes the caption per
    // MSC2530/MSC4231.
    const content: Record<string, any> = {
      msgtype: "m.image",
      filename: effectiveFilename,
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

    // Use sendMessage (Element Web's approach) instead of sendEvent. It takes
    // the same content object but ensures the event goes through the standard
    // message send pipeline, which handles E2EE encryption consistently.
    const response = await client.sendMessage(roomId, content as any);

    return {
      content: [{
        type: "text",
        text: `Image sent successfully to ${room.name || roomId}\nEvent ID: ${response.event_id}\nMXC URL: ${mxcUrl}\nSize: ${buffer.length} bytes${origSize !== buffer.length ? ` (resized from ${origSize})` : ""}${imageUrl ? `\nSource: ${imageUrl}` : ""}`,
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
export const registerImageSendingTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "send-image",
    {
      title: "Send Image to Matrix Room",
      description:
        "Upload and send an image to a Matrix room. Provide EITHER imageUrl (preferred — fetched server-side) " +
        "OR imageBase64 (base64-encoded image data). Using imageUrl avoids loading large image data into agent context. " +
        "Supports threading and replies like send-message. " +
        "The image is uploaded to the Matrix content repository and sent as an m.image event.",
      inputSchema: {
        roomId: z.string().describe("Matrix room ID (e.g., !roomid:domain.com)"),
        imageBase64: z
          .string()
          .optional()
          .describe("Base64-encoded image data (no data: prefix). Use imageUrl instead when possible."),
        imageUrl: z
          .string()
          .optional()
          .describe("URL of an image to fetch server-side and send. Preferred over imageBase64 — avoids loading image data into agent context."),
        maxWidth: z
          .number()
          .optional()
          .describe("Maximum width in pixels. Image is resized (aspect ratio preserved) if it exceeds this. Useful for large images."),
        maxHeight: z
          .number()
          .optional()
          .describe("Maximum height in pixels. Image is resized (aspect ratio preserved) if it exceeds this. Useful for large images."),
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
