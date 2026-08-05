import { redirect } from "next/navigation";
import { StateProvider } from "../components/StateProvider";
import { AppShell } from "../components/AppShell";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeeded } from "@/lib/seed";
import { getWorkspace } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function AuthedHome() {
  await ensureSeeded();
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/app");
  const ws = await getWorkspace(user.workspaceId);

  return (
    <StateProvider>
      <div className="bg-neutral-950">
        <AppShell currentUser={user} workspaceName={ws?.displayName ?? "your workspace"} />
      </div>
    </StateProvider>
  );
}
