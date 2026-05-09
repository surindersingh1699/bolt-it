import { Hash, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";

const slackScopes = [
  "channels:history",
  "channels:read",
  "app_mentions:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "users:read",
  "users:read.email",
];

const vercelEnvUrl = "https://vercel.com/dashboard/stores?redirect=/settings/environment-variables";

function getAppBaseUrl() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://it-support-agent-chi.vercel.app";
}

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
  const appBaseUrl = getAppBaseUrl();
  const slackRedirectUrl = `${appBaseUrl}/api/slack/callback`;
  const slackEventsUrl = `${appBaseUrl}/api/slack/events`;

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
            {!isMockedRealOAuth && (
              <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-950/70 p-3 text-[11px] text-neutral-300">
                <div className="font-semibold text-neutral-100">One-time Slack setup for the platform owner</div>
                <div className="mt-1 text-neutral-500">
                  Customers should never touch Slack signing secrets. You configure the app once;
                  after that they only click Connect Slack.
                </div>
                <ol className="mt-3 space-y-2 list-decimal list-inside">
                  <li>
                    Create a Slack app from manifest at{" "}
                    <a
                      href="https://api.slack.com/apps?new_app=1"
                      target="_blank"
                      rel="noreferrer"
                      className="text-violet-300 hover:text-violet-200 inline-flex items-center gap-1"
                    >
                      api.slack.com/apps <ExternalLink size={10} />
                    </a>
                    .
                  </li>
                  <li>
                    In <span className="text-neutral-100">OAuth & Permissions</span>, add this
                    redirect URL:
                    <code className="mt-1 block whitespace-normal break-all rounded bg-neutral-900 px-2 py-1 text-neutral-100">
                      {slackRedirectUrl}
                    </code>
                  </li>
                  <li>
                    Add bot scopes:
                    <code className="mt-1 block whitespace-normal break-all rounded bg-neutral-900 px-2 py-1 text-neutral-100">
                      {slackScopes.join(", ")}
                    </code>
                  </li>
                  <li>
                    In <span className="text-neutral-100">Event Subscriptions</span>, set Request
                    URL:
                    <code className="mt-1 block whitespace-normal break-all rounded bg-neutral-900 px-2 py-1 text-neutral-100">
                      {slackEventsUrl}
                    </code>
                    Subscribe to <code className="text-neutral-100">message.channels</code>,{" "}
                    <code className="text-neutral-100">message.groups</code>,{" "}
                    <code className="text-neutral-100">message.im</code>, and{" "}
                    <code className="text-neutral-100">app_mention</code>.
                  </li>
                  <li>
                    Add these Vercel env vars at{" "}
                    <a
                      href={vercelEnvUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-violet-300 hover:text-violet-200 inline-flex items-center gap-1"
                    >
                      Vercel environment variables <ExternalLink size={10} />
                    </a>
                    :
                    <code className="mt-1 block whitespace-normal break-all rounded bg-neutral-900 px-2 py-1 text-neutral-100">
                      SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, LOCAL_AGENT_TOKEN
                    </code>
                  </li>
                </ol>
                <div className="mt-3 rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5 text-emerald-200">
                  After redeploy, the company onboarding screen becomes a normal Slack install
                  button with no technical setup for the customer.
                </div>
              </div>
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
              <Hash size={12} /> {isMockedRealOAuth ? "Connect Slack" : "Use mock Slack"}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
