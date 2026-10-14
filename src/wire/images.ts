import { createHash } from "node:crypto";
import type { WireConnection } from "./client.js";
import { WireError, type WireDescribe, type WireHistoryImage, type WireImage } from "./protocol.js";

/** Bound decoding before allocation, including data supplied by extensions. */
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024;

export function decodeImageData(data: string, limit = MAX_IMAGE_BYTES): Buffer {
  if (typeof data !== "string" || !data.length || data.length > Math.ceil(limit / 3) * 4 ||
      data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new WireError("invalid_request", "image must contain canonical Base64 within the supported size limit");
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > limit || bytes.toString("base64") !== data) {
    throw new WireError("invalid_request", "image must contain canonical Base64 within the supported size limit");
  }
  return bytes;
}

export function imageId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function imageFormat(bytes: Uint8Array): "png" | "jpeg" {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  throw new WireError("invalid_request", "Xenolith accepts PNG and JPEG images only");
}

export function inlineImage(data: string, mimeType: string, budget: number): WireImage {
  const bytes = decodeImageData(data);
  const format = imageFormat(bytes);
  if (mimeType !== `image/${format}`) throw new WireError("invalid_request", "image MIME type does not match its PNG/JPEG bytes");
  return { data, budget };
}

export function imageIdentity(image: WireImage): { id: string; budget: number | undefined } {
  const id = image.data !== undefined ? imageId(decodeImageData(image.data)) : image.id;
  if (!/^[a-f0-9]{64}$/.test(id)) throw new WireError("invalid_request", "invalid image identity");
  return { id, budget: image.budget };
}

export function validateHistoryImage(image: WireHistoryImage): void {
  if (!image || !/^[a-f0-9]{64}$/.test(image.id) ||
      ![image.bytes, image.budget, image.rows].every((v) => Number.isSafeInteger(v) && v > 0) ||
      image.bytes > MAX_IMAGE_BYTES || image.rows > image.budget) {
    throw new WireError("io_error", "invalid image metadata in Xenolith history");
  }
}

/** Download original encoded bytes from the bound conversation, never a server path.
 * Hash and offsets are checked before callers can use this for reconstruction. */
export async function readImageMedia(connection: WireConnection, image: WireHistoryImage, info: WireDescribe): Promise<Buffer> {
  validateHistoryImage(image);
  if (!info.vision?.media_refs || image.bytes > info.vision.max_bytes) {
    throw new WireError("invalid_request", "the Xenolith service cannot retrieve this image");
  }
  const chunks: Buffer[] = [];
  let offset = 0;
  const limit = Math.min(262144, Math.floor((connection.maxFrameBytes - 512) * 3 / 4));
  if (limit < 1) throw new WireError("invalid_request", "the wire frame limit is too small for image retrieval");
  while (offset < image.bytes) {
    const response = await connection.request({ op: "media", image_id: image.id, offset, limit });
    if (response["offset"] !== offset || response["total"] !== image.bytes || typeof response["data"] !== "string") {
      throw new WireError("io_error", "invalid image media chunk");
    }
    const chunk = decodeImageData(response["data"], limit);
    if (offset + chunk.length > image.bytes) throw new WireError("io_error", "image media exceeded its recorded size");
    chunks.push(chunk);
    offset += chunk.length;
  }
  const bytes = Buffer.concat(chunks, image.bytes);
  if (imageId(bytes) !== image.id) throw new WireError("io_error", "image media checksum does not match its recorded identity");
  imageFormat(bytes);
  return bytes;
}
