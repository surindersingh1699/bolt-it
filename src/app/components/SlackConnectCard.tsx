import { Hash, CheckCircle2, AlertCircle } from "lucide-react";

interface SlackConnectCardProps {
  teamId?: string;
  teamName?: string;
  connectedAt?: number;
  isMockedRealOAuth: boolean;
}

export function SlackConnectCard({
  teamId,
  teamName,
  connectedAt,
  isMockedRealOAuth,
}: SlackConnectCardProps) {
  const isMockTeam = teamId?.startsWith("T_MOCK_") ?? false;
  const connected = Boolean(teamId);

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 flex items-start gap-3">
      <div className="w-9 h-9 rounded-md bg-violet-500/15 text-violet-300 flex items-center justify-center shrink-0">
        <Hash size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <div className="text-sm font-semibold text-neutral-100">Slack</div>
          {connected ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 flex items-center gap-1">
              <CheckCircle2 size={10} /> connected
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-700/40 text-neutral-300">
              not connected
            </span>
          )}
          {isMockTeam && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 flex items-center gap-1">
              <AlertCircle size={10} /> mock
            </span>
          )}
        </div>
        {connected ? (
          <div className="text-[11px] text-neutral-400 leading-relaxed">
            {teamName ?? "Slack team"} ({teamId})
            {connectedAt && (
              <span className="text-neutral-600">
                {" "}
                · connected {new Date(connectedAt).toLocaleDateString()}
              </span>
            )}
            {isMockTeam && (
              <div className="mt-1.5 text-[10px] text-amber-200/70">
                This is a placeholder. Set <code className="text-amber-200">SLACK_CLIENT_ID</code> and{" "}
                <code className="text-amber-200">SLACK_CLIENT_SECRET</code> to wire the real OAuth flow.
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-neutral-400 leading-relaxed">
            {isMockedRealOAuth ? (
              <>
                Connect your Slack workspace so users can file tickets in #it-support and the bot
                replies in-thread when resolved.
              </>
            ) : (
              <>
                Demo mode — connecting will store a placeholder team. Add{" "}
                <code className="text-neutral-200">SLACK_CLIENT_ID</code> and{" "}
                <code className="text-neutral-200">SLACK_CLIENT_SECRET</code> to your environment to
                enable the real OAuth handshake.
              </>
            )}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          {connected ? (
            <form action="/api/slack/disconnect" method="post">
              <button
                type="submit"
                className="text-[11px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-3 py-1.5 rounded transition-colors"
              >
                Disconnect
              </button>
            </form>
          ) : (
            <a
              href="/api/slack/install"
              className="text-[11px] bg-violet-500 hover:bg-violet-400 text-neutral-950 font-medium px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors"
            >
              <Hash size={12} /> Connect Slack
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
