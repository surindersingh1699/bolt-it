import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { StateProvider } from "../components/StateProvider";
import { AppShell } from "../components/AppShell";
import { SlackConnectCard } from "../components/SlackConnectCard";
import { ensureSeeded } from "@/lib/seed";
import { DEMO_COOKIE } from "@/lib/workspace";
import { getWorkspace } from "@/lib/data";
import { isSlackOAuthConfigured } from "@/lib/slack";
import { PublicUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEMO_GUEST: PublicUser = {
  email: "guest@demo.local",
  workspaceId: "",
  name: "Demo guest",
  team: "Visitor",
  title: "Trying it out",
  isITStaff: true,
};

export default async function DemoHome() {
  await ensureSeeded();
  const c = await cookies();
  const demo = c.get(DEMO_COOKIE);
  if (!demo?.value) redirect("/api/demo/start");

  const ws = await getWorkspace(demo.value);
  const guest: PublicUser = { ...DEMO_GUEST, workspaceId: demo.value };

  return (
    <StateProvider>
      <div className="bg-neutral-950">
        {!ws?.slackTeamId && (
          <div className="border-b border-neutral-800 px-6 py-3">
            <div className="max-w-3xl">
              <SlackConnectCard
                teamId={ws?.slackTeamId}
                teamName={ws?.slackTeamName}
                connectedAt={ws?.slackConnectedAt}
                isMockedRealOAuth={isSlackOAuthConfigured()}
              />
            </div>
          </div>
        )}
        <AppShell
          currentUser={guest}
          workspaceName={ws?.displayName ?? "Demo workspace"}
          demoMode
        />
      </div>
    </StateProvider>
  );
}
