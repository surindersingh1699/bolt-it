/**
 * Screenshots, on their way to the strategist.
 *
 * Stored in a PRIVATE bucket and handed to the model as a base64 data URI
 * rather than as a link. Two reasons, both load-bearing:
 *
 *  - A support screenshot routinely contains an inbox, a document, or a
 *    customer record. Making the bucket public so an image fetch can reach it
 *    would be the wrong trade for the convenience.
 *  - A data URI has no signed-URL lifetime to get wrong. The bytes go into the
 *    one request that needs them and nowhere else.
 *
 * Never throws. An attachment that cannot be read degrades to a ticket without
 * a screenshot, which is the case the strategist already handles.
 */

import { getInsforge } from "./insforge-client";
import { Attachment } from "./types";

export const ATTACHMENT_BUCKET = "ticket-attachments";

/** Only formats a vision model actually accepts. */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Above this, the base64 costs more prompt budget than the image is worth. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** How many images ride along on one strategist call. */
export const MAX_ATTACHMENTS_PER_CALL = 3;

export type UploadResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; error: string };

export function attachmentRejectionReason(mimeType: string, bytes: number): string | null {
  if (!ALLOWED_TYPES.has(mimeType)) {
    return `${mimeType || "that file type"} is not an image the agent can read — use PNG, JPEG, WebP or GIF`;
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return `that image is ${(bytes / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`;
  }
  if (bytes === 0) return "that file is empty";
  return null;
}

export async function uploadAttachment(ticketId: string, file: File): Promise<UploadResult> {
  const rejection = attachmentRejectionReason(file.type, file.size);
  if (rejection) return { ok: false, error: rejection };

  const insforge = getInsforge();
  if (!insforge) return { ok: false, error: "attachment storage is not configured" };

  // Namespaced by ticket, and the filename is sanitised because it reaches a
  // storage key: the reporter chose it, so it is untrusted input.
  const safeName = file.name.replace(/[^\w.-]/g, "_").slice(0, 80) || "screenshot";
  const key = `${ticketId}/${Date.now()}-${safeName}`;

  try {
    const { data, error } = await insforge.storage.from(ATTACHMENT_BUCKET).upload(key, file);
    if (error || !data) return { ok: false, error: error?.message ?? "upload failed" };
    return {
      ok: true,
      attachment: {
        key: data.key,
        url: data.url,
        mimeType: file.type,
        bytes: file.size,
        uploadedAt: Date.now(),
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Fetch attachments back as data URIs for a model call.
 *
 * Capped at MAX_ATTACHMENTS_PER_CALL: three screenshots of the same error are
 * three times the tokens and no more information, and an unbounded loop here
 * would let a reporter decide how large the prompt gets.
 */
export async function attachmentsAsDataUris(attachments: Attachment[]): Promise<string[]> {
  const insforge = getInsforge();
  if (!insforge || attachments.length === 0) return [];

  const out: string[] = [];
  for (const a of attachments.slice(0, MAX_ATTACHMENTS_PER_CALL)) {
    try {
      const { data: blob, error } = await insforge.storage.from(ATTACHMENT_BUCKET).download(a.key);
      if (error || !blob) continue;
      const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
      out.push(`data:${a.mimeType};base64,${base64}`);
    } catch {
      // Deliberately ignored — a screenshot we cannot read is a ticket without
      // a screenshot, not a failed ticket.
    }
  }
  return out;
}
