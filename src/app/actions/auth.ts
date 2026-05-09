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
  DEMO_COOKIE,
  clearDemoCookie,
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

const signupSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  password: z.string().min(6).max(200),
  team: z.string().max(80).optional(),
  title: z.string().max(120).optional(),
  isITStaff: z.string().optional(),
});

export async function signupAction(formData: FormData): Promise<void> {
  await ensureSeeded();
  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name"),
    password: formData.get("password"),
    team: formData.get("team") ?? "",
    title: formData.get("title") ?? "",
    isITStaff: formData.get("isITStaff") ?? "",
  });
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "invalid_input";
    redirect(`/signup?err=${encodeURIComponent(reason)}`);
  }
  const { email: rawEmail, name, password, team, title, isITStaff } = parsed.data;
  const email = rawEmail.toLowerCase().trim();
  const domain = domainFromEmail(email);
  const workspace = await ensureWorkspace(
    domain,
    workspaceDisplayNameForDomain(domain) + " Corp",
    false,
  );
  const existingGlobalUser = await getADUser(email);
  if (existingGlobalUser) {
    redirect(`/signup?err=email_taken&email=${encodeURIComponent(email)}`);
  }
  const existing = await getADUser(email, workspace.id);
  if (existing) {
    redirect(`/signup?err=email_taken&email=${encodeURIComponent(email)}`);
  }
  // First user in a workspace becomes IT staff (the admin).
  const peers = await listADUsers(workspace.id);
  const isFirstUser = peers.length === 0;
  const now = Date.now();
  const user: ADUser = {
    email,
    workspaceId: workspace.id,
    name: name.trim(),
    passwordHash: await hashPassword(password),
    team: (team ?? "").trim() || "general",
    title: (title ?? "").trim() || "Member",
    groups: ["everyone"],
    isITStaff: isITStaff === "on" || isITStaff === "true" || isFirstUser,
    createdAt: now,
  };
  const account: ADAccount = {
    email,
    workspaceId: workspace.id,
    status: "active",
    failedLoginCount: 0,
    passwordChangedAt: now,
    passwordExpiresAt: now + 90 * 24 * 60 * 60 * 1000,
  };
  await insertADUser(user);
  await insertADAccount(account);

  // If the user came from /demo, carry their demo workspace contents into the new permanent workspace.
  const c = await cookies();
  const demoCookie = c.get(DEMO_COOKIE);
  if (demoCookie?.value && demoCookie.value !== workspace.id) {
    try {
      await reassignWorkspace(demoCookie.value, workspace.id);
    } catch (err) {
      console.error("[signup] Demo workspace carry-over failed", err);
    }
    await clearDemoCookie();
  }

  await setSessionCookie(email, workspace.id);
  revalidatePath("/", "layout");
  redirect("/app");
}

const demoLoginSchema = z.object({
  email: z.string().email().max(200),
});

export async function demoLoginAction(formData: FormData): Promise<void> {
  await ensureSeeded();
  const parsed = demoLoginSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) redirect("/login?err=bad_credentials");
  const email = parsed.data.email.toLowerCase().trim();
  const user = await getADUser(email, ACME_WORKSPACE_ID);
  if (!user) redirect(`/login?err=bad_credentials&email=${encodeURIComponent(email)}`);
  await setSessionCookie(email, user!.workspaceId);
  revalidatePath("/", "layout");
  redirect("/app");
}
