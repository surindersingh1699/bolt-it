"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { cookies } from "next/headers";
import { attemptLogin, clearSessionCookie, setSessionCookie } from "@/lib/auth";
import { getADUser, insertADAccount, insertADUser, listADUsers, reassignWorkspace } from "@/lib/data";
import { hashPassword } from "@/lib/password";
import { ensureSeeded } from "@/lib/seed";
import { ADAccount, ADUser } from "@/lib/types";
import {
  ACME_WORKSPACE_ID,
  domainFromEmail,
  ensureWorkspace,
  workspaceDisplayNameForDomain,
} from "@/lib/workspace";

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

export async function loginAction(formData: FormData): Promise<void> {
  await ensureSeeded();
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    redirect(`/login?err=bad_credentials&email=${encodeURIComponent(String(formData.get("email") ?? ""))}`);
  }
  const { email, password } = parsed.data;
  const result = await attemptLogin(email, password);
  if (!result.ok || !result.user) {
    const failure = result.failure ?? "bad_credentials";
    redirect(`/login?err=${failure}&email=${encodeURIComponent(email)}`);
  }
  await setSessionCookie(result.user!.email, result.user!.workspaceId);
  revalidatePath("/", "layout");
  redirect("/app");
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  revalidatePath("/", "layout");
  redirect("/login");
}

