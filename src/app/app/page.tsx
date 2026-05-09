import { redirect } from "next/navigation";
import { StateProvider } from "../components/StateProvider";
import { AppShell } from "../components/AppShell";
import { SlackConnectCard } from "../components/SlackConnectCard";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeeded } from "@/lib/seed";
import { getWorkspace } from "@/lib/data";
import { isSlackOAuthConfigured } from "@/lib/slack";

export const dynamic = "force-dynamic";

interface AuthedHomeProps {
  searchParams: Promise<{ slack?: string; detail?: string }>;
}

export default async function AuthedHome({ searchParams }: AuthedHomeProps) {
  await ensureSeeded();
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/app");
  const ws = await getWorkspace(user.workspaceId);
  const sp = await searchParams;
  const slackBanner = sp.slack;

  return (
    <StateProvider>
      <div className="bg-neutral-950">
        {slackBanner && (
          <div className="border-b border-neutral-800 px-6 py-2 text-[11px] text-neutral-300 bg-neutral-900">
            Slack: {slackBanner.replace(/_/g, " ")}
            {sp.detail ? ` (${sp.detail})` : ""}
          </div>
        )}
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
        <AppShell currentUser={user} workspaceName={ws?.displayName ?? "your workspace"} />
      </div>
    </StateProvider>
  );
}
