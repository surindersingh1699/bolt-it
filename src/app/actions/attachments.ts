"use server";

import { revalidatePath } from "next/cache";
import { getTicket, updateTicket } from "@/lib/data";
import { uploadAttachment } from "@/lib/attachments";
import { getCurrentUser } from "@/lib/auth";

/**
 * Attach a screenshot to a ticket.
 *
 * The authorisation check is not ceremony: this image is read by the model that
 * decides what runs on someone's machine, so who can put one on a ticket is a
 * real question. The reporter, or IT staff. Nobody else.
 */
export async function attachToTicket(
  ticketId: string,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "not signed in" };

  const ticket = await getTicket(ticketId);
  if (!ticket) return { ok: false, error: "no such ticket" };
  if (ticket.reporterEmail !== user.email && !user.isITStaff) {
    return { ok: false, error: "that is not your ticket" };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "no file supplied" };

  const result = await uploadAttachment(ticketId, file);
  if (!result.ok) return { ok: false, error: result.error };

  await updateTicket(ticketId, {
    attachments: [...(ticket.attachments ?? []), result.attachment],
  });
  revalidatePath("/");
  return { ok: true };
}
